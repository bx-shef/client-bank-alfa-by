// Ensure a portal has a valid access token before a REST call: refresh via B24
// OAuth when near expiry (needs the app's B24_CLIENT_ID/B24_CLIENT_SECRET) and
// persist the result. Without those creds it returns the stored token as-is — a
// freshly-installed token is valid ~1h, enough for the skeleton test right after
// install; add the creds for long-lived operation.

import { B24_OAUTH_TOKEN_URL, buildRefreshBody, hostFromEndpoint, parseRefreshResponse } from './b24Oauth'
import { saveToken } from './tokenStore'
import type { PortalToken, QueryFn } from './tokenStore'

/** True when the access token is within `skewMs` of expiry (pure, testable). */
export function needsRefresh(token: PortalToken, nowMs: number, skewMs = 60_000): boolean {
  return token.expiresAt <= nowMs + skewMs
}

export async function ensureAccessToken(query: QueryFn, token: PortalToken): Promise<PortalToken> {
  if (!needsRefresh(token, Date.now())) return token

  const clientId = process.env.B24_CLIENT_ID?.trim()
  const clientSecret = process.env.B24_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) {
    // Can't refresh — hand back the stored token (may already be expired).
    console.warn('[ensureAccessToken] near/at expiry but B24_CLIENT_ID/SECRET unset — cannot refresh')
    return token
  }

  const json = await $fetch(B24_OAUTH_TOKEN_URL, {
    method: 'POST',
    body: buildRefreshBody({ clientId, clientSecret }, token.refreshToken),
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  })
  const r = parseRefreshResponse(json)
  const updated: PortalToken = {
    ...token,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken || token.refreshToken,
    expiresAt: Date.now() + r.expiresIn * 1000,
    domain: hostFromEndpoint(r.clientEndpoint) ?? token.domain
  }
  await saveToken(query, updated)
  return updated
}
