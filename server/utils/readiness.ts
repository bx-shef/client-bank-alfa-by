// Readiness probe core (closes the OPERATIONS.md gap that liveness /api/health
// stays green while Postgres/Redis are down; queue-depth telemetry is the separate #78
// follow-up). Unlike /api/health (pure process liveness),
// readiness actually PROBES the backend's hard dependencies so `docker compose ps` / an
// uptime monitor / an on-call responder can tell "process up" from "app actually able to
// work". Booleans only — NO secrets, NO queue depth (that's the session-gated
// /api/ops/queues and `make queue-stats`).
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

import { gatewayOrigin } from '../../app/utils/bankGatewayUrl'

export interface ReadinessChecks {
  /** Postgres reachable (SELECT 1 succeeded). */
  db: boolean
  /** Redis reachable (PING); null when REDIS_URL is unset (queues off — not an error). */
  redis: boolean | null
  /** BY-crypto gateway answering its own /healthz (#460/#461); null when it is not in use.
   *  INFORMATIONAL — deliberately excluded from `ready`/`status`, see `evaluateReadiness`. */
  cryptoGw: boolean | null
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

/** Which address to probe the crypto gateway at, derived from the two INDEPENDENT Prior
 *  addresses the app actually calls. `null` = the gateway is not in use.
 *
 *  «Through the gateway» is decided by `gatewayOrigin` (app/utils/bankGatewayUrl.ts) — the same
 *  rule `make doctor` is checked against, so the two cannot drift apart again (#770 was exactly
 *  that drift: a prefix check here missed `HTTP://…`). "In use" is derived from the addresses rather
 *  than from a separate flag, because a flag would drift from reality and reporting reality is the
 *  whole point of the field.
 *
 *  ⚠ BOTH addresses are checked, and that is not belt-and-braces. The documented production shape
 *  is the token endpoint behind the gateway with the resource API still on the bank's public host
 *  — so looking only at the API base would report «шлюз не используется» while every token refresh
 *  goes through it, and a responder would read the one field meant to answer «is the gateway up?»
 *  as «not my problem», in exactly the outage it exists for.
 *
 *  Lives here, not inline in the route, because route bodies carry no tests in this codebase:
 *  inlined, the check above silently reverted to API-base-only would still pass the whole suite. */
export function gatewayProbeBase(apiBase: string | null, tokenUrl: string | null): string | null {
  // Probe whichever address goes through the gateway; when both do, the API base wins (arbitrary
  // but stable — in that configuration they are the same gateway anyway).
  return gatewayOrigin(apiBase) ?? gatewayOrigin(tokenUrl)
}

export interface ReadinessDeps {
  /** Resolves true when a cheap DB round-trip succeeds. MUST NOT throw — wrap I/O. */
  checkDb: () => Promise<boolean>
  /** True when REDIS_URL is configured (queues enabled). */
  redisConfigured: () => boolean
  /** Resolves true when a Redis PING succeeds. Only called when redisConfigured() is true. */
  pingRedis: () => Promise<boolean>
  /** True when Prior's traffic is routed through the crypto gateway (#460). */
  cryptoGwConfigured: () => boolean
  /** Resolves true when the gateway answers its own /healthz. Only called when configured. */
  pingCryptoGw: () => Promise<boolean>
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

/** Evaluate readiness from the injected probes. All probes run concurrently. */
export async function evaluateReadiness(deps: ReadinessDeps): Promise<ReadinessResult> {
  const configured = deps.redisConfigured()
  const gwConfigured = deps.cryptoGwConfigured()
  const [db, redis, cryptoGw] = await Promise.all([
    probe(deps.checkDb),
    configured ? probe(deps.pingRedis) : Promise.resolve<null>(null),
    gwConfigured ? probe(deps.pingCryptoGw) : Promise.resolve<null>(null)
  ])
  // down: DB unreachable → nothing works. degraded: DB up but a configured Redis is down
  // → API + B24 events (sync DB fallback) still serve, imports stalled. ok: otherwise.
  //
  // ⚠ `cryptoGw` is REPORTED but does NOT move the verdict, on purpose. The gateway serves
  // exactly one bank; Bitrix24 events, manual upload and Alfa keep working without it. Letting
  // it flip `ready` would turn a Priorbank-only outage into a 503 for every uptime monitor —
  // and, wherever this endpoint is wired to a container healthcheck, into a restart loop of a
  // perfectly healthy backend. The field exists so an on-call responder can SEE the gateway
  // state at the one URL they already hit; alerting on Prior belongs to the queue alerts.
  const status: ReadinessStatus = !db ? 'down' : redis === false ? 'degraded' : 'ok'
  return { ready: status === 'ok', status, checks: { db, redis, cryptoGw } }
}
