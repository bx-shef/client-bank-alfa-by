// Per-portal RestCall resolver on the @bitrix24/b24jssdk transport (#191). The SDK's
// per-instance RestrictionManager (leaky-bucket rate limiter + retry-backoff on
// QUERY_LIMIT_EXCEEDED / 429 / 5xx) IS the rate-limiter — this is why we swap the crm-sync
// transport to it (the neighbouring ai-price-import repo did the same: it abandoned building
// its own limiter and took the SDK's).
//
// DESIGN — a per-portal client MEMOISED for a short TTL, NOT rebuilt per resolution and NOT a
// process-lifetime cache. A crm-sync job makes many per-op resolves; building a fresh client
// each time would give each op its OWN rate-limiter bucket (so the per-portal 2 req/s limit is
// NOT shared across the job → burst → QUERY_LIMIT_EXCEEDED under volume) and re-load the token
// per op. Memoising the client per member_id for `ttlMs` makes a whole job share ONE client
// (one bucket, one token load — the per-JOB memoisation). Two safety valves against the stale-
// token wedge (a cached B24OAuth holds the refresh token in memory, so a PEER replica or the
// keep-alive cron (#175) rotating it leaves the cached client failing `invalid_grant`):
//   1. EVICT-ON-ERROR (primary): a failed call drops its own client, so the NEXT resolve
//      rebuilds from the fresh DB token immediately — recovery is capped to the next retry, not
//      the TTL. The cache is a worker-lifetime singleton that survives BullMQ retries, and the
//      retry budget (attempts×backoff) can be SHORTER than the TTL; without evict-on-error the
//      wedged client would be re-handed to every retry until the TTL lapsed, burning the budget.
//   2. TTL (backstop): even a never-failing client is rebuilt after `ttlMs`, so a rotation is
//      picked up within the window regardless.
// A lost call is a transient BullMQ retry, never cred corruption. `evict` drops a portal
// immediately on uninstall.
//
// REFRESH RACE — the SDK refreshes OUTSIDE our advisory lock (ensureAccessToken, #35). Two
// concurrent same-portal refreshes can race the rotation: one wins, the other gets
// `invalid_grant`, its job fails, BullMQ retries, the retry re-reads the now-rotated token and
// succeeds. The persist is tombstone-guarded `saveToken` (won't resurrect a purged portal), so
// a lost race is a TRANSIENT retryable failure, never cred corruption. The advisory lock still
// serialises the PROACTIVE keep-alive cron (#175). This IS the crm-sync transport (the former
// advisory-locked `callRest` resolver was retired once the SDK became the default).

import type { RestBatch, RestCall } from './companyLookup'
import { makePortalSdkClient, makeSdkBatchCall, makeSdkRestCall, type SdkPortalDeps } from './b24Sdk'

/** A per-portal resolver: `(memberId) → RestCall | null`, memoised for a short TTL, with
 *  `evict(memberId)` to drop a portal's cached client (called on uninstall) and `batch(memberId)`
 *  to get a `RestBatch` bound to the SAME memoised client (shares its rate-limiter bucket +
 *  token load). This is the crm-sync REST transport contract; the SDK resolver below is its sole
 *  implementation. */
export interface PortalRestResolver {
  (memberId: string): Promise<RestCall | null>
  /** Drop a portal's cached client so the next resolve rebuilds (uninstall cutoff). */
  evict(memberId: string): void
  /** A `RestBatch` over the same memoised client, or `null` when the portal has no token. */
  batch(memberId: string): Promise<RestBatch | null>
}

/** How long a per-portal SDK client is reused before it's rebuilt from a fresh DB token.
 *  Long enough to serve a whole crm-sync job from ONE client (shared rate-limiter bucket + one
 *  token load); short enough that a peer/keep-alive token rotation wedges the cached client for
 *  at most this window before a rebuild picks up the rotated token. */
export const SDK_CLIENT_TTL_MS = 60_000

/**
 * Build a `PortalRestResolver` backed by the SDK transport, memoising the per-portal
 * `B24OAuth` client for `ttlMs` (per-JOB memoisation, #191). Resolves `null` for a portal with
 * no stored token (uninstalled / demo) and never caches the `null`. `evict(memberId)` drops the
 * cached client so an uninstall cuts over immediately. `now`/`ttlMs` are injectable for tests.
 * This is the sole crm-sync transport — the former manual `callRest` resolver and its
 * `QUEUE_SDK_TRANSPORT` flag were removed (#191).
 */
export function createPortalSdkResolver(
  deps: SdkPortalDeps,
  now: () => number = Date.now,
  ttlMs: number = SDK_CLIENT_TTL_MS
): PortalRestResolver {
  interface Entry { call: RestCall, batch: RestBatch, builtAt: number }
  const cache = new Map<string, Entry>()

  // Resolve (or rebuild) the cached client for a portal, returning its wrapped call+batch.
  // Both the RestCall and the RestBatch are wrapped so a FAILED request drops its (possibly
  // stale/wedged) client — the next resolve then rebuilds from the fresh DB token immediately,
  // instead of waiting out the TTL. The cache is a worker-lifetime singleton that survives
  // BullMQ retries, and our retry budget (attempts×backoff) can be shorter than
  // SDK_CLIENT_TTL_MS; without this, a client wedged by a peer/keep-alive rotation
  // (invalid_grant) would be re-handed to every retry until the TTL lapsed, burning the whole
  // budget before recovery (#191). Eviction is guarded to THIS exact entry so a concurrent
  // rebuild's newer client is never dropped. call and batch share ONE client (and its
  // rate-limiter bucket), and either's failure evicts that shared client.
  const ensure = async (memberId: string): Promise<Entry | null> => {
    const cached = cache.get(memberId)
    if (cached && now() - cached.builtAt < ttlMs) return cached
    const client = await makePortalSdkClient(memberId, deps)
    if (!client) {
      cache.delete(memberId) // no token → never cache the null (re-resolve next time)
      return null
    }
    const rawCall = makeSdkRestCall(client, { memberId })
    const rawBatch = makeSdkBatchCall(client)
    const evictSelf = (): void => {
      if (cache.get(memberId) === entry) cache.delete(memberId)
    }
    const call: RestCall = async (method, params) => {
      try {
        return await rawCall(method, params)
      } catch (e) {
        evictSelf()
        throw e
      }
    }
    const batch: RestBatch = async (calls) => {
      try {
        return await rawBatch(calls)
      } catch (e) {
        evictSelf()
        throw e
      }
    }
    const entry: Entry = { call, batch, builtAt: now() }
    cache.set(memberId, entry)
    return entry
  }

  const resolver = (async (memberId: string): Promise<RestCall | null> => {
    const entry = await ensure(memberId)
    return entry ? entry.call : null
  }) as PortalRestResolver
  resolver.evict = (memberId: string) => void cache.delete(memberId)
  resolver.batch = async (memberId: string): Promise<RestBatch | null> => {
    const entry = await ensure(memberId)
    return entry ? entry.batch : null
  }
  return resolver
}
