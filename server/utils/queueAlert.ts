// Pure decision core for queue alerting (#426, ported from `ai-price-import`).
//
// `/queues` shows a SNAPSHOT: how many jobs are waiting right now. A snapshot cannot tell apart the
// two states that actually matter — «навалило работы, но она разгребается» (fine) and «навалило
// работы, и она не двигается» (broken: dead worker, wedged portal token, bank outage). Both look
// like a big number.
//
// TWO WRONG DESIGNS PRECEDED THIS ONE (kept from the source port — both looked obviously right):
//
//  1. **Дельта `completed`/`failed` между замерами.** Those are not counters — they are the sizes of
//     retained sets, capped by our retention options (producers.ts). On a busy queue `completed`
//     pins at its cap and stops growing, so the delta is zero exactly while everything works: a
//     permanent false alarm under normal load, and silence during a real outage once `failed` hit
//     its own cap. An operator retrying a failed job made the delta NEGATIVE, alerting the moment
//     somebody fixed something.
//  2. **Порог по размеру хвоста (50+ ждущих).** Ties the alarm to volume, so it can only ever fire
//     for big portals. `b24-events` carries installs and uninstalls — единицы событий; with its
//     worker dead, portals silently lose their tokens and the backlog never reaches 50. A quiet
//     portal's crm-sync could stand still for a day behind five waiting jobs. The loudest failures
//     are the quietest ones.
//
// What is measured instead is **how long the oldest unfinished job has been sitting there**. It
// needs no retained history (job timestamps survive any trimming), no previous snapshot, and no
// assumption about traffic.

import { Q_CRM, Q_DELETIONS, Q_EVENTS, Q_FEEDBACK, Q_FETCH, Q_FETCH_PRIOR, Q_PARSE, Q_TRIGGER, type QueueName } from '../queue/topology'
import { pluralRu } from '../../app/utils/importStatus'

/**
 * How long the oldest unfinished job may legitimately sit, PER QUEUE. `null` — правило простоя к
 * очереди не применяется.
 *
 * ⚠ This is the one place the port DIVERGES from `ai-price-import`, and it has to. There a single
 * 20-minute threshold covers every queue, because every queue there is a fast path with a person
 * waiting at the end of it. Here three of the eight queues are SLOW BY DESIGN, and a flat threshold
 * would page us constantly about the system working exactly as specified:
 *
 *  - **`bank-fetch` / `bank-fetch-prior`** — the poller is deliberately back-pressured by the global
 *    bank rate cap (A8): one job per connected account, and a full sweep takes `accounts / rate`
 *    minutes (`estimatePollCycle` computes precisely this, and `exceedsInterval` already warns when
 *    a sweep outgrows the tick). At marketplace scale the oldest waiting fetch is legitimately hours
 *    old. A budget still exists — a genuinely dead fetch worker must surface eventually — but it is
 *    sized for the drain rate, not for «должно быть мгновенно».
 *  - **`trigger-fire`** — durable retry with exponential backoff over 12 attempts (#79): the delays
 *    sum to `60s × (2¹¹ − 1)` ≈ **34 hours** of legitimate `delayed` time, because the job is
 *    waiting for the portal admin to register the trigger CODE and self-heals when they do. That
 *    wait is somebody else's action, not our outage. An earlier draft exempted the queue entirely
 *    (`null`), which was wrong in the other direction: with the rule off AND its worker dead,
 *    nothing would ever exhaust its attempts either, so the queue became invisible to alerting
 *    altogether. The budget is therefore finite but past the whole backoff ladder.
 *  - **`feedback-post`** — durable retry over 8 attempts (~1 hour of GitHub flakiness by design), so
 *    the budget is двукратный запас поверх этого, not 20 minutes.
 *
 * The fast paths keep the source's 20 minutes: `b24-events` (install/uninstall — a stall means
 * portals silently lose tokens), `file-parse`/`crm-sync` (a person uploaded a file and is waiting
 * for the result), `b24-deletions` (a CRM entity was removed and the ledger is drifting until it
 * is reconciled).
 */
export const STALL_BUDGET_MS: Record<QueueName, number | null> = {
  [Q_EVENTS]: 20 * 60 * 1000,
  [Q_PARSE]: 20 * 60 * 1000,
  [Q_CRM]: 20 * 60 * 1000,
  [Q_DELETIONS]: 20 * 60 * 1000,
  [Q_FETCH]: 6 * 60 * 60 * 1000,
  [Q_FETCH_PRIOR]: 6 * 60 * 60 * 1000,
  [Q_FEEDBACK]: 2 * 60 * 60 * 1000,
  // 48 h > the ~34 h backoff ladder, so normal self-healing never trips it, but a dead worker does.
  [Q_TRIGGER]: 48 * 60 * 60 * 1000
}

/** Budget for a queue name that is not in the table — a queue added without touching this file.
 *  Deliberately generous AND non-null: silence would make the new queue invisible to alerting
 *  forever, but a tight default would page on its first legitimate backlog. */
export const DEFAULT_STALL_BUDGET_MS = 60 * 60 * 1000

export function stallBudgetMs(queue: string): number | null {
  return queue in STALL_BUDGET_MS ? STALL_BUDGET_MS[queue as QueueName] : DEFAULT_STALL_BUDGET_MS
}

/**
 * Failures within the look-back window that mean «падает системно».
 *
 * Low because of what actually lands in BullMQ's `failed` set, and what `countRecentFailures` then
 * keeps of it. A rejection the app works out ITSELF — unreadable file, unrecognised format, an
 * operation excluded by settings — never reaches `failed`: the handler records the reason and
 * returns normally. A per-portal REST refusal (no rights, portal deauthorised) DOES throw, but is
 * excluded a layer below by `isServiceFailure` (queueHealthRead.ts): those are deterministic per
 * portal, so counting them would tie this alert to the number of misconfigured tenants rather than
 * to our health. What is left is our own breakage: Redis gone, the transport failing, a worker dying.
 *
 * Three of OUR failures in an hour is a fault — at a few statements an hour a higher bar would be
 * unreachable, and everything could be broken while the count sat at one or two.
 */
export const FAILURE_ALERT_THRESHOLD = 3

/** How far back failures are counted. An hour rather than fifteen minutes for the same reason: at a
 *  few jobs an hour, a fifteen-minute window can be empty even while everything is broken. */
export const FAILURE_WINDOW_MS = 60 * 60 * 1000

/** `bank-dead` — НЕ поломка конвейера, а мёртвые банковские подключения (#497 §3,
 *  `bankHealthAlert.ts`). Живёт в этом union потому, что доставку (один раз на эпизод, пол на
 *  переобъявление, «объявлено» = реально доставлено) уже умеет `planAlertDelivery`, и второй такой
 *  механизм означал бы второй набор его ошибок. */
export type QueueAlertKind = 'stalled' | 'failing' | 'unreadable' | 'bank-dead' | 'keepalive-stale'

export interface QueueAlert {
  kind: QueueAlertKind
  /** Предмет эпизода: имя очереди для поломок конвейера, id провайдера для `bank-dead`. */
  queue: string
  /** Ready-to-show Russian sentence; the caller decides where it goes. */
  text: string
}

/** One queue as the health check sees it. Every field survives BullMQ's retention caps. */
export interface QueueHealthInput {
  queue: string
  /**
   * True when the queue could not be read at all (Redis down, connection refused).
   *
   * This MUST be distinct from «прочитали, там пусто». The counts reader answers an unreachable
   * Redis with zeros (`queue/stats.ts`), which is the most dangerous possible lie here: the whole
   * pipeline being dead would render as an empty, healthy queue — a green screen during a total
   * outage.
   */
  unreadable?: boolean
  /** Age of the oldest job not yet finished (waiting / active / delayed), ms. `null` — очередь пуста. */
  oldestPendingAgeMs: number | null
  /** How many jobs are unfinished — for the message only; never a condition. */
  pending: number
  /** Failures within `FAILURE_WINDOW_MS`. Counted by timestamp, not by set size. */
  recentFailures: number
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

/** «45 мин» / «3 ч 20 мин» — a bank-fetch stall is measured in hours, and «380 мин» is unreadable. */
function humanAge(ms: number): string {
  const m = minutes(ms)
  if (m < 90) return `${m} мин`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest === 0 ? `${h} ч` : `${h} ч ${rest} мин`
}

/**
 * Judge one reading of the pipeline. Empty list = healthy, so the caller can report unconditionally.
 *
 * Three rules:
 *
 *  - **unreadable** — the queue could not be read. Reported instead of, not alongside, the others:
 *    with no data every other verdict would be invented.
 *  - **stalled** — the oldest unfinished job has outlived that queue's budget (`stallBudgetMs`).
 *    `delayed` counts as unfinished: a job bouncing in retry-backoff is not progress — except on
 *    the queues whose backoff IS the design, which carry a `null` budget.
 *  - **failing** — jobs are exhausting their retries. Not counted as a stall (the queue IS moving),
 *    because reporting one breakage under two names teaches people to read neither.
 */
export function evaluateQueueHealth(queues: QueueHealthInput[], _nowMs?: number): QueueAlert[] {
  const out: QueueAlert[] = []

  for (const q of queues) {
    if (q.unreadable) {
      out.push({
        kind: 'unreadable',
        queue: q.queue,
        text: `очередь «${q.queue}» не читается — состояние конвейера неизвестно (проверьте Redis)`
      })
      continue
    }

    const budget = stallBudgetMs(q.queue)
    if (budget !== null && q.oldestPendingAgeMs !== null && q.oldestPendingAgeMs > budget) {
      out.push({
        kind: 'stalled',
        queue: q.queue,
        text: `очередь «${q.queue}» не разгребается: ${q.pending} ${pluralRu(q.pending, ['задача ждёт', 'задачи ждут', 'задач ждут'])}, самая старая — уже ${humanAge(q.oldestPendingAgeMs)}`
      })
    }

    if (q.recentFailures >= FAILURE_ALERT_THRESHOLD) {
      out.push({
        kind: 'failing',
        queue: q.queue,
        text: `очередь «${q.queue}»: ${q.recentFailures} ${pluralRu(q.recentFailures, ['задача исчерпала', 'задачи исчерпали', 'задач исчерпали'])} все попытки за последний час`
      })
    }
  }

  return out
}
