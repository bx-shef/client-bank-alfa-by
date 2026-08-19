// Ensure a portal has a valid access token before a REST call: refresh via B24
// OAuth when near expiry (needs the app's B24_CLIENT_ID/B24_CLIENT_SECRET) and
// persist the rotated tokens. Without those creds it returns the stored token as-is.
//
// CONCURRENCY (scale-out): the refresh is serialized per portal with a Postgres
// advisory lock, and re-reads the freshest token INSIDE the lock — so when N workers
// hit the same near-expiry portal, exactly ONE refreshes (rotating the refresh token)
// and the rest reuse the result. Without this, concurrent refreshes race on B24's
// refresh-token rotation and permanently break the portal's stored credentials.
//
// TRANSPORT: the actual refresh POST goes through the jssdk (`sdkRefreshTransport` →
// `B24OAuth.auth.refreshAuth`), so ALL outbound B24 traffic shares one transport. This is the
// keep-alive path's only remaining use (#175) — the crm-sync hot path uses the SDK's own reactive
// refresh. The advisory lock stays HERE because the SDK's reactive refresh bypasses it (#35).

import { buildRefreshBody, hostFromEndpoint, parseRefreshResponse } from './b24Oauth'
import { sdkRefreshTransport } from './b24Sdk'
import { withAdvisoryLock } from './dbLock'
import { getToken, updatePortalTokenSecrets } from './tokenStore'
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
  /** UPDATE-only (#510): `false` = регистрации портала уже нет, создавать её рефреш не вправе. */
  saveToken: (q: QueryFn, token: PortalToken) => Promise<boolean>
  /** POST the refresh body to B24 OAuth and return the raw JSON. */
  postRefresh: (body: string) => Promise<unknown>
}

const liveDeps: RefreshDeps = {
  now: Date.now,
  withLock: withAdvisoryLock,
  loadToken: getToken,
  saveToken: updatePortalTokenSecrets,
  // Refresh through the jssdk transport (`B24OAuth.auth.refreshAuth`), bounded (15s) so a hung
  // OAuth call can't pin the advisory lock + pooled connection (the whole refresh runs in the lock).
  postRefresh: sdkRefreshTransport({ timeoutMs: 15_000 })
}

/**
 * Return a valid access token for the portal, refreshing (once, under a per-portal
 * lock) if within the skew of expiry. Persists the rotated access+refresh tokens.
 * `deps` defaults to live (advisory lock + jssdk refresh via `sdkRefreshTransport`); tests inject fakes.
 *
 * `opts.force` refreshes even when the token looks clock-fresh — for a REACTIVE retry
 * after B24 rejected the access token before its computed expiry (clock skew / early
 * invalidation). Still serialized by the SAME advisory lock, and inside the lock it only
 * refreshes when the stored token is STILL the one that was rejected — if another worker
 * already rotated it, that fresh token is returned instead (no redundant refresh, so B24's
 * frequent-refresh auto-block risk is avoided).
 */
export async function ensureAccessToken(
  token: PortalToken,
  deps: RefreshDeps = liveDeps,
  opts: { force?: boolean } = {}
): Promise<PortalToken> {
  if (!opts.force && !needsRefresh(token, deps.now())) return token

  const clientId = process.env.B24_CLIENT_ID?.trim()
  const clientSecret = process.env.B24_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) {
    // Can't refresh — hand back the stored token (may already be expired).
    console.warn('[ensureAccessToken] near/at expiry but B24_CLIENT_ID/SECRET unset — cannot refresh')
    return token
  }

  return deps.withLock(`b24refresh:${token.memberId}`, async (q) => {
    // Re-read INSIDE the lock — another worker may have refreshed while we waited.
    const stored = await deps.loadToken(q, token.memberId)
    // Portal uninstalled between the pre-lock check and acquiring the lock → its row is gone.
    // Return the passed token as-is; the downstream REST call fails and nothing is persisted
    // for a portal that no longer exists.
    //
    // ⚠ This early exit is now an OPTIMISATION, not the safety net (#510). It only narrows the
    // window: the refresh POST below is a network call to Bitrix's OAuth server with a 15s
    // ceiling, and an uninstall landing in those seconds would still have found an upsert
    // waiting to re-create the row. The actual guarantee is that the persist is UPDATE-only —
    // after the DELETE there is simply nothing to update, whatever the ordering.
    if (!stored) return token
    // Force path: refresh only if the stored access token is STILL the rejected one; if a
    // concurrent worker already rotated it, use theirs (avoids a redundant refresh that
    // would rotate the refresh token again). Non-force path: clock-based as before.
    const shouldRefresh = opts.force ? stored.accessToken === token.accessToken : needsRefresh(stored, deps.now())
    if (!shouldRefresh) return stored

    const r = parseRefreshResponse(await deps.postRefresh(buildRefreshBody({ clientId, clientSecret }, stored.refreshToken)))
    const updated: PortalToken = {
      ...stored,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken || stored.refreshToken,
      expiresAt: deps.now() + r.expiresIn * 1000,
      domain: hostFromEndpoint(r.clientEndpoint) ?? stored.domain
    }
    // ⚠ `false` (регистрации уже нет) НЕ ошибка и не повод бросать: портал удалили, пока мы
    // ходили в OAuth-сервер. Возвращаем обновлённую пару вызывающему — его REST-вызов честно
    // упадёт на несуществующем портале, — но в БД не осталось ничего, что пришлось бы потом
    // подчищать. Ровно тот исход, ради которого запись сделана UPDATE-only (#510).
    await deps.saveToken(q, updated)
    return updated
  })
}
