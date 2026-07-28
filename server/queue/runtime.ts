// Queue runtime role — pure env parsing, so the plugin stays thin and testable.
//
// One image, three roles by env (see docs/QUEUES.md «Масштабирование»):
//   - single container (default): workers ON + cron ON — one instance does it all;
//   - HTTP/primary container: QUEUE_WORKERS=0 (serves the API + runs the cron),
//     jobs drained by dedicated worker containers;
//   - worker container: QUEUE_CRON=0 (+ RUN_MIGRATION=0), scaled to N replicas —
//     all pull from the same Redis, so adding replicas adds throughput.

import { providerJobRate, REQUESTS_PER_ACCOUNT } from './pollCapacity'

export interface QueueRuntime {
  /** Start the BullMQ workers in this instance (drain the queues). */
  workers: boolean
  /** Run the cron/demo scheduler in this instance — must be exactly ONE instance,
   *  else N schedulers enqueue duplicate fetch jobs. */
  cron: boolean
  /** Per-worker concurrency for the throughput queues (fetch/parse/crm-sync). */
  concurrency: number
  /** GLOBAL rate limit for the bank-fetch queue (A8). BullMQ's worker `limiter` is
   *  shared across ALL replicas on the same queue via a Redis key (global, not per-instance
   *  — verified against the installed bullmq 5.x source), so this caps live Alfa calls across
   *  the whole fleet at `max` per `duration` ms. Default 100/60s = Alfa's per-client cap (our
   *  app has ONE Alfa client_id, so a single global cap is correct). NB a fetch JOB is ~one
   *  Alfa request (token refresh is near-expiry-only + per-account locked); if Alfa counts
   *  its `/token` endpoint in the SAME bucket, lower this for headroom during refresh bursts. */
  fetchRate: { max: number, duration: number }
  /** GLOBAL rate limit for the PRIOR bank-fetch queue, expressed in JOBS (what BullMQ counts).
   *  Prior's async create+poll spends ~10 bank REQUESTS per job, so the job rate is derived from
   *  the request budget by `providerJobRate` — sizing it with the raw request cap would overspend
   *  the bank budget ~10×. Separate from `fetchRate` because it is a different queue with a
   *  different bank and a different cost model. */
  priorFetchRate: { max: number, duration: number }
  /** Per-worker concurrency for the PRIOR fetch queue. Its own knob because a Prior job holds its
   *  slot for the whole create+poll loop (up to minutes) — sharing QUEUE_CONCURRENCY with the fast
   *  queues would either starve Prior or over-parallelize the others. */
  priorConcurrency: number
}

/** Upper bound so a typo (`QUEUE_CONCURRENCY=100000`) can't exhaust the B24 REST
 *  quota / DB pool. B24 limits are per-portal anyway — batch, don't just widen. */
export const MAX_CONCURRENCY = 100

/** Bank-fetch rate defaults (A8): Alfa allows ~100 requests/min per OAuth client. */
export const DEFAULT_FETCH_RATE_MAX = 100
export const DEFAULT_FETCH_RATE_DURATION_MS = 60_000
/** Bounds so a fat-fingered value can't effectively DISABLE the cap: a huge `max`
 *  (`999999`) or a tiny `duration` (`1`ms) would both let the fleet hammer the bank.
 *  10× headroom over the default covers a higher Alfa tier; the window floor stops a
 *  sub-second bucket. Both edges clamp, so the cap can never be turned off by a typo. */
export const MAX_FETCH_RATE_MAX = 1_000
export const MIN_FETCH_RATE_DURATION_MS = 1_000

/** Prior's REQUEST budget per window (not jobs — see `providerJobRate`). Conservative by default:
 *  the bank hard-throttles (429) per account and no published per-client cap is confirmed, so start
 *  at Alfa's order of magnitude and raise only against a documented Prior limit. */
export const DEFAULT_PRIOR_REQUEST_MAX = 100
/** Default per-worker concurrency for Prior fetches — several slow create+poll jobs may sit in
 *  their sleep windows at once without spending extra bank budget (the limiter still caps rate). */
export const DEFAULT_PRIOR_CONCURRENCY = 4

/** A boolean env flag: unset/empty → default; `0/false/no/off` (any case) → false. */
export function envFlag(value: string | undefined, dflt: boolean): boolean {
  if (value === undefined || value.trim() === '') return dflt
  return !/^(0|false|no|off)$/i.test(value.trim())
}

/** Resolve the queue role from the environment (defaults = single-container). */
export function queueRuntimeConfig(env: NodeJS.ProcessEnv = process.env): QueueRuntime {
  return {
    workers: envFlag(env.QUEUE_WORKERS, true),
    cron: envFlag(env.QUEUE_CRON, true),
    concurrency: clampConcurrency(env.QUEUE_CONCURRENCY),
    fetchRate: {
      max: clampFetchMax(env.QUEUE_FETCH_RATE_MAX),
      duration: clampFetchDuration(env.QUEUE_FETCH_RATE_DURATION_MS)
    },
    priorFetchRate: {
      // env holds Prior's REQUEST budget; the limiter needs JOBS → divide by the per-job cost.
      max: providerJobRate(
        clampPriorRequestMax(env.QUEUE_PRIOR_RATE_MAX),
        REQUESTS_PER_ACCOUNT['prior-by'] ?? 1
      ),
      duration: clampFetchDuration(env.QUEUE_PRIOR_RATE_DURATION_MS)
    },
    priorConcurrency: clampPriorConcurrency(env.QUEUE_PRIOR_CONCURRENCY)
  }
}

/** Prior REQUEST budget: same both-edges defence as the Alfa cap (a typo can't disable it). */
function clampPriorRequestMax(value: string | undefined): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PRIOR_REQUEST_MAX
  return Math.min(MAX_FETCH_RATE_MAX, n)
}

function clampPriorConcurrency(value: string | undefined): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PRIOR_CONCURRENCY
  return Math.min(MAX_CONCURRENCY, n)
}

function clampConcurrency(value: string | undefined): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(MAX_CONCURRENCY, n)
}

/** Fetch-rate `max`: 0/negative/garbage → default (can't turn the cap OFF via a low/garbage value),
 *  AND clamp the UPPER edge to `MAX_FETCH_RATE_MAX` so a fat-fingered `999999` can't effectively
 *  disable it either. Both edges are defended. */
function clampFetchMax(value: string | undefined): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_FETCH_RATE_MAX
  return Math.min(MAX_FETCH_RATE_MAX, n)
}

/** Fetch-rate `duration` (ms): 0/negative/garbage → default, AND floor at `MIN_FETCH_RATE_DURATION_MS`
 *  so a tiny window (`1`ms → a near-unbounded rate) can't defeat the cap. */
function clampFetchDuration(value: string | undefined): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_FETCH_RATE_DURATION_MS
  return Math.max(MIN_FETCH_RATE_DURATION_MS, n)
}
