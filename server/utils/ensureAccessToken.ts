// Ensure a portal has a valid access token before a REST call: refresh via B24
// OAuth when near expiry (needs the app's B24_CLIENT_ID/B24_CLIENT_SECRET) and
// persist the rotated tokens. Without those creds it returns the stored token as-is.
//
// CONCURRENCY (scale-out): the refresh is serialized per portal with a Postgres
// advisory lock, and re-reads the freshest token INSIDE the lock — so when N workers
// hit the same near-expiry portal, exactly ONE refreshes (rotating the refresh token)
// and the rest reuse the result. Without this, concurrent refreshes race on B24's
// refresh-token rotation and permanently break the portal's stored credentials.

import { B24_OAUTH_TOKEN_URL, buildRefreshBody, hostFromEndpoint, parseRefreshResponse } from './b24Oauth'
import { withAdvisoryLock } from './dbLock'
import { getToken, saveToken } from './tokenStore'
import type { PortalToken, QueryFn } from './tokenStore'

/** True when the access token is within `skewMs` of expiry (pure, testable). */
export function needsRefresh(token: PortalToken, nowMs: number, skewMs = 60_000): boolean {
  return token.expiresAt <= nowMs + skewMs
}

/** Injected side-effects, so the refresh logic is unit-testable without DB/network. */
export interface RefreshDeps {
  now: () => number
  /** Run `fn` under a per-portal lock, giving it a store-bound QueryFn (see dbLock). */
  withLock: <T>(key: string, fn: (q: QueryFn) => Promise<T>) => Promise<T>
  /** Load the portal's freshest token (on the locked connection `q`). */
  loadToken: (q: QueryFn, memberId: string) => Promise<PortalToken | null>
  /** Persist the refreshed token (on the locked connection `q`). */
  saveToken: (q: QueryFn, token: PortalToken) => Promise<void>
  /** POST the refresh body to B24 OAuth and return the raw JSON. */
  postRefresh: (body: string) => Promise<unknown>
}

const liveDeps: RefreshDeps = {
  now: Date.now,
  withLock: withAdvisoryLock,
  loadToken: getToken,
  saveToken,
  postRefresh: body => $fetch(B24_OAUTH_TOKEN_URL, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  })
}

/**
 * Return a valid access token for the portal, refreshing (once, under a per-portal
 * lock) if within the skew of expiry. Persists the rotated access+refresh tokens.
 * `deps` defaults to live (advisory lock + `$fetch`); tests inject fakes.
 */
export async function ensureAccessToken(token: PortalToken, deps: RefreshDeps = liveDeps): Promise<PortalToken> {
  if (!needsRefresh(token, deps.now())) return token

  const clientId = process.env.B24_CLIENT_ID?.trim()
  const clientSecret = process.env.B24_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) {
    // Can't refresh — hand back the stored token (may already be expired).
    console.warn('[ensureAccessToken] near/at expiry but B24_CLIENT_ID/SECRET unset — cannot refresh')
    return token
  }

  return deps.withLock(`b24refresh:${token.memberId}`, async (q) => {
    // Re-read INSIDE the lock — another worker may have refreshed while we waited.
    const fresh = (await deps.loadToken(q, token.memberId)) ?? token
    if (!needsRefresh(fresh, deps.now())) return fresh

    const r = parseRefreshResponse(await deps.postRefresh(buildRefreshBody({ clientId, clientSecret }, fresh.refreshToken)))
    const updated: PortalToken = {
      ...fresh,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken || fresh.refreshToken,
      expiresAt: deps.now() + r.expiresIn * 1000,
      domain: hostFromEndpoint(r.clientEndpoint) ?? fresh.domain
    }
    await deps.saveToken(q, updated)
    return updated
  })
}
