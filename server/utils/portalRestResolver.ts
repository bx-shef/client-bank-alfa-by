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
import { needsRefresh } from './ensureAccessToken'

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
  const resolver = (async (memberId: string) => {
    const cached = cache.get(memberId)
    if (cached && !needsRefresh(cached.token, now(), skewMs)) return cached.call
    const token = await deps.loadToken(memberId)
    if (!token) {
      cache.delete(memberId) // no token → never cache; allow a later re-resolve
      return null
    }
    const fresh = await deps.ensureFresh(token)
    const call: RestCall = (method, params) => deps.callRest(fresh.domain, fresh.accessToken, method, params)
    cache.set(memberId, { call, token: fresh })
    return call
  }) as PortalRestResolver
  resolver.evict = (memberId: string) => void cache.delete(memberId)
  return resolver
}
