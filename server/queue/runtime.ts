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
  /** Use the @bitrix24/b24jssdk transport (built-in RestrictionManager rate-limiter) for the
   *  crm-sync REST calls (#191). **Default OFF (opt-in)** — the transport is validated against a
   *  live portal (`pnpm sdk:crm:test`), but flipping the PRODUCTION default waits until a real
   *  crm-sync job is observed processing through the SDK in the actual BullMQ worker (the live
   *  gate exercised `makePortalSdkCall` directly, bypassing the queue/worker path). Set
   *  `QUEUE_SDK_TRANSPORT=1` to opt an instance in; it falls back to the advisory-locked
   *  `callRest` resolver when off. */
  sdkTransport: boolean
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
    concurrency: clampConcurrency(env.QUEUE_CONCURRENCY),
    sdkTransport: envFlag(env.QUEUE_SDK_TRANSPORT, false)
  }
}

/** Pick the crm-sync REST resolver by the `sdkTransport` flag, building ONLY the chosen one
 *  (the thunks are lazy — the SDK branch never constructs its deps when the flag is off, and
 *  vice versa). Extracted as a pure, generic seam so the flag→resolver selection is unit-
 *  testable (worker.ts wires it at module load, which a test can't drive). */
export function pickPortalResolver<T>(useSdk: boolean, buildSdk: () => T, buildCallRest: () => T): T {
  return useSdk ? buildSdk() : buildCallRest()
}

function clampConcurrency(value: string | undefined): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(MAX_CONCURRENCY, n)
}
