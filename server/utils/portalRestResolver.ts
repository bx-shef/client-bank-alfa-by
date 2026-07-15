// Bind-once per-portal RestCall resolver (#191, lever-2). A crm-sync job makes many
// per-op REST calls (findCompany + resolveIntents + writeActivity + notifyChat +
// applyAllocation + notifyError …). Each previously called `makePortalRestCall`, which
// re-loads the token from Postgres and runs the refresh check — so a batch of N ops did
// up to ~6·N token loads. This resolver binds the portal's RestCall ONCE and reuses it
// until the access token nears expiry, collapsing that to ~1 token load per portal per
// token-lifetime while staying transport-agnostic (the SDK swap later just replaces the
// underlying `callRest`).
//
// SAFETY — no staleness. `makePortalRestCall` freezes the access token into the returned
// closure, so a cached call must NOT be reused past the token's expiry. We cache the
// bound call with the token it was bound to and re-bind once `needsRefresh` is true — the
// SAME predicate (and skew) the OAuth layer uses to decide a refresh, so the resolver's
// reuse window and `ensureAccessToken`'s refresh window never drift. Reuse is therefore
// only ever of a token the OAuth layer still considers fresh. A missing token (portal not
// installed / uninstalled mid-run) is never cached, so a later install re-resolves; and
// `evict` drops a portal's entry immediately on uninstall (restores the instant cutoff).
//
// CONCURRENCY: the cache stores the resolved call (not the in-flight promise), so two
// concurrent FIRST touches of the same portal each load+bind once (last write wins) — a
// harmless redundant load, made race-safe by `ensureAccessToken`'s per-portal advisory
// lock. The resolver assumes per-portal ops are effectively serialized (the crm-sync
// handler awaits them), which is where the "~1 bind per portal" guarantee holds.

import type { RestCall } from './companyLookup'
import type { PortalRestDeps } from './portalRest'
import type { PortalToken } from './tokenStore'
import { ensureAccessToken, needsRefresh } from './ensureAccessToken'
import { isExpiredTokenError } from './b24Rest'

/** Build the resolver's `ensureFresh` dep from an `ensureAccessToken`-shaped refresh,
 *  THREADING the reactive `{force}` opt through (the middle `deps` arg is left at its
 *  default). The whole expired_token retry (#191) is dead the instant `force` stops
 *  reaching `ensureAccessToken` — and the two NON-retry sibling wirings (`liveDeps`,
 *  `appSettings`) intentionally drop `opts`, so an "align it with the siblings" edit would
 *  silently disarm the retry with every test still green. Hence a named, unit-tested unit
 *  (see tests/portalRestResolver.test.ts) rather than an inline `(t) => ensureAccessToken(t)`
 *  lambda. Defaults to the live `ensureAccessToken`; the fn is injectable for the guard test. */
export function makeEnsureFresh(refresh: typeof ensureAccessToken = ensureAccessToken): PortalRestDeps['ensureFresh'] {
  return (token, opts) => refresh(token, undefined, opts)
}

/** A per-portal resolver: `(memberId) → RestCall | null`, memoised until near expiry,
 *  with `evict(memberId)` to drop a portal's cached bind (called on uninstall). */
export interface PortalRestResolver {
  (memberId: string): Promise<RestCall | null>
  /** Drop a portal's cached bind so the next resolve re-loads (uninstall cutoff). */
  evict(memberId: string): void
}

/**
 * Build a resolver over the same `PortalRestDeps` as `makePortalRestCall`, plus an
 * injectable clock (`now`) for tests. Caches the bound `RestCall` per member_id with the
 * token it was bound to; re-binds when `needsRefresh(token, now(), skewMs)` is true.
 * Returns `null` (uncached) for a portal with no token.
 */
export function createPortalRestResolver(
  deps: PortalRestDeps,
  now: () => number = Date.now,
  skewMs?: number
): PortalRestResolver {
  const cache = new Map<string, { call: RestCall, token: PortalToken }>()

  // A bound RestCall with a REACTIVE retry: if B24 rejects the (clock-fresh) access token
  // — `expired_token`/`invalid_token`, e.g. early server-side invalidation the expiry check
  // can't see — force a refresh (advisory-locked in `ensureAccessToken`, so it stays
  // single-writer under scale-out) and retry ONCE, updating the cache so later calls use the
  // fresh token. Non-expiry errors propagate unchanged. Only one retry (a second rejection
  // throws) — no loop. Mirrors ai-price-import's retry-once, but keeps our advisory lock.
  const makeCall = (memberId: string, bound: PortalToken): RestCall => async (method, params) => {
    try {
      return await deps.callRest(bound.domain, bound.accessToken, method, params)
    } catch (err) {
      if (!isExpiredTokenError(err)) throw err
      const refreshed = await deps.ensureFresh(bound, { force: true })
      cache.set(memberId, { call: makeCall(memberId, refreshed), token: refreshed })
      return await deps.callRest(refreshed.domain, refreshed.accessToken, method, params)
    }
  }

  const resolver = (async (memberId: string) => {
    const cached = cache.get(memberId)
    if (cached && !needsRefresh(cached.token, now(), skewMs)) return cached.call
    const token = await deps.loadToken(memberId)
    if (!token) {
      cache.delete(memberId) // no token → never cache; allow a later re-resolve
      return null
    }
    const fresh = await deps.ensureFresh(token)
    const call = makeCall(memberId, fresh)
    cache.set(memberId, { call, token: fresh })
    return call
  }) as PortalRestResolver
  resolver.evict = (memberId: string) => void cache.delete(memberId)
  return resolver
}
