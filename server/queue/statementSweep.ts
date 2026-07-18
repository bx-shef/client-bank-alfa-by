// Wall-clock retention sweep for the statement-PII queues (#245 follow-up, docs/PRIVACY.md
// «Гарантия по стенным часам»). BullMQ's `removeOnComplete/Fail.age` eviction is LAZY — it
// only fires when the NEXT terminal job lands in that queue, so on an idle portal the last
// ≤50 completed / ≤200 failed statement payloads (file bytes, normalized StatementItem[])
// can linger in Redis well past their age. This periodic sweep calls `queue.clean(grace, …)`
// on the cron instance to delete them EAGERLY on a timer — an actual wall-clock guarantee,
// not "until the next job".
//
// Pure core: no bullmq/Redis import here. The plugin injects a `clean(queue, graceMs, type)`
// that wraps `getQueue(name).clean(...)`, so this orchestrator is unit-testable without Redis
// (mirrors tokenKeepAlive.ts / saturation.ts). Grace periods are the SAME wall-clock cutoffs
// the lazy `STATEMENT_JOB_RETENTION.age` uses — we apply them eagerly, we don't shorten them.

import { STATEMENT_JOB_RETENTION } from './producers'
import { Q_CRM, Q_PARSE } from './topology'

/** The two queues whose payloads carry financial PII (file bytes / StatementItem[]). */
export const SWEPT_QUEUES = [Q_PARSE, Q_CRM] as const
export type SweptQueue = typeof SWEPT_QUEUES[number]

/** Upper clamp on the sweep interval so a huge env value can't overflow `setInterval`'s
 *  2^31-1 ms ceiling (Node silently clamps the overflow to 1 ms → a tight loop). 7 days. */
export const MAX_SWEEP_INTERVAL_MIN = 7 * 24 * 60

/** Grace (ms) after which a COMPLETED statement job is swept — the same cutoff as the lazy
 *  `removeOnComplete.age`, applied eagerly. */
export const SWEEP_COMPLETED_GRACE_MS = STATEMENT_JOB_RETENTION.removeOnComplete.age * 1000
/** Grace (ms) after which a FAILED statement job is swept — mirrors `removeOnFail.age`
 *  (kept longer than completed for post-mortem, still bounded). */
export const SWEEP_FAILED_GRACE_MS = STATEMENT_JOB_RETENTION.removeOnFail.age * 1000

/** Sweep interval in ms from a minutes setting. Clamped to [1min, MAX_SWEEP_INTERVAL_MIN];
 *  default 30min. Pure — the upper clamp keeps `setInterval` under its 2^31-1 ms ceiling. */
export function sweepIntervalMs(minutes: number): number {
  const m = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 30
  return Math.min(Math.max(1, m), MAX_SWEEP_INTERVAL_MIN) * 60_000
}

/** A single clean job: which queue, which terminal set, how old. */
export interface SweepTarget {
  queue: SweptQueue
  type: 'completed' | 'failed'
  graceMs: number
}

/** The full sweep plan: both statement queues × both terminal sets, each with its grace. */
export function sweepPlan(): SweepTarget[] {
  const plan: SweepTarget[] = []
  for (const queue of SWEPT_QUEUES) {
    plan.push({ queue, type: 'completed', graceMs: SWEEP_COMPLETED_GRACE_MS })
    plan.push({ queue, type: 'failed', graceMs: SWEEP_FAILED_GRACE_MS })
  }
  return plan
}

export interface SweepDeps {
  /** Delete jobs of `type` older than `graceMs` in `queue`; returns the removed job ids.
   *  Wraps `getQueue(queue).clean(graceMs, 0, type)` in the plugin. */
  clean: (queue: SweptQueue, graceMs: number, type: 'completed' | 'failed') => Promise<string[]>
  log?: (message: string) => void
  warn?: (message: string) => void
}

export interface SweepSummary {
  completedRemoved: number
  failedRemoved: number
  /** Number of individual clean calls that threw (isolated — never aborts the sweep). */
  failed: number
}

/**
 * Run one sweep over both statement queues (completed + failed). Each `clean` call is
 * isolated: a failure of one (Redis blip, one queue absent) is counted and logged but never
 * aborts the others or throws — so the timer keeps its wall-clock guarantee for the queues
 * that DID sweep. Returns removed counts for logging/metrics.
 */
export async function runStatementSweep(deps: SweepDeps): Promise<SweepSummary> {
  const s: SweepSummary = { completedRemoved: 0, failedRemoved: 0, failed: 0 }
  for (const target of sweepPlan()) {
    try {
      const removed = await deps.clean(target.queue, target.graceMs, target.type)
      const n = removed.length
      if (target.type === 'completed') s.completedRemoved += n
      else s.failedRemoved += n
    } catch (e) {
      s.failed++
      deps.warn?.(`[sweep] clean failed for ${target.queue}/${target.type}: ${(e as { message?: string })?.message ?? String(e)}`)
    }
  }
  deps.log?.(`[sweep] statement queues: completedRemoved=${s.completedRemoved} failedRemoved=${s.failedRemoved} failed=${s.failed}`)
  return s
}
