// Queue runtime role — pure env parsing, so the plugin stays thin and testable.
//
// One image, three roles by env (see docs/QUEUES.md «Масштабирование»):
//   - single container (default): workers ON + cron ON — one instance does it all;
//   - HTTP/primary container: QUEUE_WORKERS=0 (serves the API + runs the cron),
//     jobs drained by dedicated worker containers;
//   - worker container: QUEUE_CRON=0 (+ RUN_MIGRATION=0), scaled to N replicas —
//     all pull from the same Redis, so adding replicas adds throughput.

export interface QueueRuntime {
  /** Start the BullMQ workers in this instance (drain the queues). */
  workers: boolean
  /** Run the cron/demo scheduler in this instance — must be exactly ONE instance,
   *  else N schedulers enqueue duplicate fetch jobs. */
  cron: boolean
  /** Per-worker concurrency for the throughput queues (fetch/parse/crm-sync). */
  concurrency: number
}

/** Upper bound so a typo (`QUEUE_CONCURRENCY=100000`) can't exhaust the B24 REST
 *  quota / DB pool. B24 limits are per-portal anyway — batch, don't just widen. */
export const MAX_CONCURRENCY = 100

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
    concurrency: clampConcurrency(env.QUEUE_CONCURRENCY)
  }
}

function clampConcurrency(value: string | undefined): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(MAX_CONCURRENCY, n)
}

/** Which CRM activity carrier crm-sync writes an operation as (#259 Phase B). */
export type ActivityTransport = 'todo' | 'configurable'

/**
 * Resolve the activity transport from the environment. Default `todo`
 * (crm.activity.todo.add + the persistent activity_dedup store). `ACTIVITY_TRANSPORT=configurable`
 * switches to crm.activity.configurable.add, whose ORIGINATOR_ID/ORIGIN_ID marker enables
 * B24-side dedup (crm.activity.list search) — no store needed, and the write→remember gap is
 * closed (marker written atomically with the activity).
 *
 * OFF by default because configurable.add is OAuth/app-context only (ERROR_WRONG_CONTEXT) and
 * cannot be webhook-tested — it needs a live-verify on an installed portal before flipping, the
 * same opt-in discipline as QUEUE_SDK_TRANSPORT. Only the exact token `configurable` (any case,
 * trimmed) turns it on; anything else falls back to `todo` (fail-safe: a typo can't silently
 * switch the real write path).
 */
export function activityTransport(env: NodeJS.ProcessEnv = process.env): ActivityTransport {
  return String(env.ACTIVITY_TRANSPORT ?? '').trim().toLowerCase() === 'configurable' ? 'configurable' : 'todo'
}
