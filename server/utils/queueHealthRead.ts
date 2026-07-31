import { QUEUE_NAMES, type QueueName } from '../queue/topology'
import { FAILURE_WINDOW_MS, type QueueHealthInput } from './queueAlert'

// Reading side of the queue health check (#426, ported from `ai-price-import`). Pure over an
// injected reader — the live one wraps BullMQ, tests use a fake. Kept apart from `queue/stats.ts`
// on purpose: that one answers an unreachable Redis with zeros (the operator page must still
// render), and here zeros would be a lie that turns a total outage into a green screen.

/** Raw shapes we need. Only the fields used — BullMQ's Job carries far more. */
export interface RawPendingJob { timestamp?: number | null }
export interface RawFailedAt {
  finishedOn?: number | null
  processedOn?: number | null
  /** Why it died. Used only to tell OUR breakage from one portal's misconfiguration. */
  failedReason?: string | null
}

/**
 * Portal answers that mean «этот клиент настроил у себя не то», not «сервис сломан».
 *
 * They matter because they are DETERMINISTIC: revoked rights, a missing scope or a deauthorised
 * portal produce the same refusal on every attempt and on every statement that portal sends.
 * Counting them would tie the alert to the number of misconfigured tenants — one client with a
 * wrong setting would page us hourly, forever, about something only that client can fix.
 *
 * Same principle as the stall rule refusing to depend on portal size: an alert must describe the
 * health of the service, not the shape of its clients. Our own portal-side vocabulary (checked
 * against `docs/OPERATIONS.md` and `provisionRequest.ts`): `insufficient_scope` (a right the portal
 * never granted — e.g. `userfieldconfig` for SP provisioning), `ACCESS_DENIED`, `PAYMENT_REQUIRED`
 * (expired paid plan), `invalid_grant` / `expired_token` (the app was removed in the portal),
 * `ERROR_WRONG_CONTEXT` (an OAuth-only method reached through a webhook token).
 *
 * ⚠ `invalid_grant` пачкой по ВСЕМ порталам — это уже наша авария (сменили `B24_CLIENT_SECRET`), и
 * этот фильтр её скроет. Ловится не здесь, а по `stalled` на `crm-sync`: работа перестаёт уходить,
 * и очередь встаёт. Отдельный сигнал «умер токен портала» — follow-up в #426.
 */
const PORTAL_SIDE_PATTERNS = [
  // `[\s_]` — Битрикс отдаёт и `ACCESS_DENIED`, и «Access denied».
  /access[\s_]*denied/i,
  /insufficient[\s_]*scope/i,
  /insufficient\s+rights/i,
  /нет\s+прав/i,
  /payment[\s_]*required/i,
  /invalid[\s_]*grant/i,
  /expired[\s_]*token/i,
  /invalid[\s_]*token/i,
  /error[\s_]*wrong[\s_]*context/i,
  /портал\s+не\s+авторизован/i,
  /сущность\s+crm\s+не\s+поддерживается/i,
  /entity\s+.*not\s+supported/i
]

/**
 * Does this failure say something about OUR service?
 *
 * Unknown wording counts as ours — fail-open. A refusal we have not seen before is more likely a new
 * way for the service to break than a new way for a client to misconfigure theirs, and a missing
 * alert costs more than an extra one.
 */
export function isServiceFailure(reason: unknown): boolean {
  const r = String(reason ?? '')
  return !PORTAL_SIDE_PATTERNS.some(re => re.test(r))
}

export interface QueueHealthReader {
  /** Unfinished jobs (waiting + active + delayed). Throws when the queue is unreachable. */
  pending: (name: QueueName) => Promise<RawPendingJob[]>
  /** Recently failed jobs, newest first. Throws when the queue is unreachable. */
  failed: (name: QueueName) => Promise<RawFailedAt[]>
}

/**
 * Cap on how many failed rows we look at.
 *
 * Safe only because BullMQ's `getFailed(start, end)` returns rows **newest first**
 * (`getJobs(['failed'], …, asc = false)`), so the cap trims the OLD tail — the rows that are outside
 * the look-back window anyway. Were it ascending, a big outage would fill the cap with ancient
 * failures, the recent ones would never be read, and the count would drop to zero exactly when it
 * matters most. Past the alert threshold the exact number stops mattering: «упало 40» and «упало
 * 400» call for the same action.
 */
export const MAX_FAILED_SCAN = 200

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Age of the oldest job, and how many there are. Jobs without a usable timestamp are counted but
 *  cannot age — better than inventing an age and alerting on it. */
export function summarisePending(jobs: RawPendingJob[], nowMs: number): { pending: number, oldestPendingAgeMs: number | null } {
  let oldest: number | null = null
  for (const j of jobs) {
    const t = num(j?.timestamp)
    if (t === null) continue
    // A clock skew (job stamped in the future) must not read as a huge age.
    const age = Math.max(0, nowMs - t)
    if (oldest === null || age > oldest) oldest = age
  }
  return { pending: jobs.length, oldestPendingAgeMs: oldest }
}

/** How many of these failed inside the window AND say something about our service. Rows with no
 *  timestamp are not counted — an undated failure could be from any time, and guessing «сейчас»
 *  would raise false alarms. Portal-side refusals are excluded, see `isServiceFailure`. */
export function countRecentFailures(jobs: RawFailedAt[], nowMs: number, windowMs = FAILURE_WINDOW_MS): number {
  let n = 0
  for (const j of jobs) {
    const t = num(j?.finishedOn) ?? num(j?.processedOn)
    if (t === null) continue
    if (!(nowMs - t <= windowMs && t <= nowMs)) continue
    if (!isServiceFailure(j?.failedReason)) continue
    n++
  }
  return n
}

/**
 * Read every pipeline queue. One unreachable queue is reported as `unreadable` and does not stop the
 * others — a partial reading is still worth acting on.
 */
export async function readQueueHealth(reader: QueueHealthReader, nowMs: number): Promise<QueueHealthInput[]> {
  const out: QueueHealthInput[] = []
  for (const queue of QUEUE_NAMES) {
    try {
      const [pending, failed] = await Promise.all([reader.pending(queue), reader.failed(queue)])
      out.push({
        queue,
        ...summarisePending(pending, nowMs),
        recentFailures: countRecentFailures(failed, nowMs)
      })
    } catch {
      out.push({ queue, unreadable: true, oldestPendingAgeMs: null, pending: 0, recentFailures: 0 })
    }
  }
  return out
}
