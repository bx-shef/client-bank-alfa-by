// Readiness probe core (closes the OPERATIONS.md gap that liveness /api/health
// stays green while Postgres/Redis are down; queue-depth telemetry is the separate #78
// follow-up). Unlike /api/health (pure process liveness),
// readiness actually PROBES the backend's hard dependencies so `docker compose ps` / an
// uptime monitor / an on-call responder can tell "process up" from "app actually able to
// work". Booleans only — NO secrets, NO queue depth (that's the token-gated /api/queues).
//
// Semantics:
//   - db: Postgres reachable (a `SELECT 1`). HARD requirement — DATABASE_URL is mandatory
//     (envCheck), the token store / crm-sync can't function without it.
//   - redis: null when REDIS_URL is unset (queues intentionally OFF — the backend still
//     serves API and B24 events via the synchronous DB fallback, so that's NOT unready);
//     true/false when configured (a PING). A configured-but-unreachable Redis IS unready
//     (imports/fetch/crm-sync can't drain).
//   ready = db AND redis !== false.
//
// Pure over injected probes (DI) → unit-testable without a real DB/Redis; the route wires
// the live probes.

export interface ReadinessChecks {
  /** Postgres reachable (SELECT 1 succeeded). */
  db: boolean
  /** Redis reachable (PING); null when REDIS_URL is unset (queues off — not an error). */
  redis: boolean | null
}

/** Coarse status for consumers that want more than the `ready` boolean:
 *  - `down`     — Postgres unreachable: nothing works (token store / crm-sync dead).
 *  - `degraded` — DB up but a CONFIGURED Redis is unreachable: the API + B24 install/uninstall
 *                 events still work (events persist via the synchronous DB fallback), but
 *                 imports/fetch/crm-sync can't drain. Serving, but not fully.
 *  - `ok`       — DB up and Redis up (or queues intentionally off). */
export type ReadinessStatus = 'ok' | 'degraded' | 'down'

export interface ReadinessResult {
  /** True only when status is `ok` — the route maps this to HTTP 200 vs 503. */
  ready: boolean
  status: ReadinessStatus
  checks: ReadinessChecks
}

export interface ReadinessDeps {
  /** Resolves true when a cheap DB round-trip succeeds. MUST NOT throw — wrap I/O. */
  checkDb: () => Promise<boolean>
  /** True when REDIS_URL is configured (queues enabled). */
  redisConfigured: () => boolean
  /** Resolves true when a Redis PING succeeds. Only called when redisConfigured() is true. */
  pingRedis: () => Promise<boolean>
}

/** Run a probe, coercing any throw/rejection to `false` — a readiness probe reports
 *  "down", it never propagates the failure (that would 500 instead of a clean 503). */
async function probe(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await fn() === true
  } catch {
    return false
  }
}

/** Evaluate readiness from the injected probes. `db` and `redis` run concurrently. */
export async function evaluateReadiness(deps: ReadinessDeps): Promise<ReadinessResult> {
  const configured = deps.redisConfigured()
  const [db, redis] = await Promise.all([
    probe(deps.checkDb),
    configured ? probe(deps.pingRedis) : Promise.resolve<null>(null)
  ])
  // down: DB unreachable → nothing works. degraded: DB up but a configured Redis is down
  // → API + B24 events (sync DB fallback) still serve, imports stalled. ok: otherwise.
  const status: ReadinessStatus = !db ? 'down' : redis === false ? 'degraded' : 'ok'
  return { ready: status === 'ok', status, checks: { db, redis } }
}
