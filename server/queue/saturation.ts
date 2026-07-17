// Bank-fetch saturation signal (A8 follow-up; docs/OPERATIONS.md «Сигналы, которые НЕ
// видны в дефолтных счётчиках»). The live Alfa poll is capped by a GLOBAL BullMQ queue
// limiter (default 100/60s, QUEUE_FETCH_RATE_*). When the plan enqueues faster than the
// cap drains, BullMQ DEFERS the excess fetch jobs — a rate-limited job is not popped from
// the `wait` list until the limiter TTL expires (verified against bullmq 5.80.5:
// moveToActive returns early before RPOPLPUSH), so it stays counted in `waiting` (retry
// backoff lands in `delayed`); nothing is dropped and no attempt is burned. In the default
// queue counters that pile-up is INDISTINGUISHABLE from ordinary backlog, so an operator
// can't tell "hit the rate cap" from "a worker is stuck". This pure helper turns the raw
// bank-fetch counts into an explicit verdict the cron tick logs, so saturation is a named
// signal, not a mystery. NB: `waiting`+`delayed` covers deferred + retrying jobs; if fetch
// jobs ever gain a `priority`, rate-limited ones would sit in `prioritized` instead — add
// that state here then (today enqueueFetch sets no priority).
//
// Pure (no Redis) → unit-testable; the plugin reads the live counts and passes numbers in.

/** Subset of BullMQ `getJobCounts()` we care about for fetch backlog. Both optional so a
 *  partial/garbage snapshot coerces to 0 rather than NaN. */
export interface FetchQueueCounts {
  waiting?: number
  delayed?: number
}

export interface SaturationVerdict {
  /** waiting + delayed on the bank-fetch queue — jobs enqueued but not yet processed. */
  backlog: number
  /** true when backlog ≥ threshold (log the explicit saturation warning). */
  over: boolean
}

/** Default backlog threshold at which we treat a growing bank-fetch queue as rate-limit
 *  saturation. Sized above a single poll's fan-out (one job per connected account) so a
 *  normal tick never trips it — only a sustained pile-up does. Override via
 *  QUEUE_FETCH_SATURATION_THRESHOLD. */
export const DEFAULT_FETCH_SATURATION_THRESHOLD = 200

/** Clamp the configured threshold: non-finite / ≤0 (env typo, `disable` attempts) fall back
 *  to the default so a bad value can't silence the signal by making it unreachable. */
export function clampSaturationThreshold(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_FETCH_SATURATION_THRESHOLD
}

/** Compute the bank-fetch backlog and whether it has crossed the saturation threshold.
 *  Negative/garbage counts coerce to 0 (a snapshot can never mean "negative jobs"). */
export function fetchBacklogSaturation(
  counts: FetchQueueCounts,
  threshold: number = DEFAULT_FETCH_SATURATION_THRESHOLD
): SaturationVerdict {
  const waiting = Number.isFinite(counts.waiting) ? Math.max(0, Math.floor(counts.waiting as number)) : 0
  const delayed = Number.isFinite(counts.delayed) ? Math.max(0, Math.floor(counts.delayed as number)) : 0
  const backlog = waiting + delayed
  return { backlog, over: backlog >= clampSaturationThreshold(threshold) }
}
