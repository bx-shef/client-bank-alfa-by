// Adapter: a per-portal Bitrix24 OAuth client (@bitrix24/b24jssdk) exposed as our
// `RestCall` (#191). The SDK ships a RestrictionManager — a PER-INSTANCE leaky-bucket
// rate limiter (default 2 req/s, burst 50) with adaptive delay and retry-backoff on
// QUERY_LIMIT_EXCEEDED / 429 / 5xx, enabled by default. Building ONE `B24OAuth` per
// portal per crm-sync job therefore gives:
//   - per-portal rate limiting (B24 limits are per-portal — one big portal can't starve
//     the others, because each portal has its own bucket), and
//   - bind-`RestCall`-once (the token is resolved once for the whole job, not per op),
// solving both remaining #191 levers together. Token refresh is automatic; the SDK's
// `setCallbackRefreshAuth` hands us the new token so we persist it to our own store.
//
// This is a server-only module, so it uses the SDK the normal way: a value import and a
// real `new B24OAuth(...)` in `makePortalSdkCall`. The pure mapping helpers
// (`oauthParamsFromToken`/`tokenFromOAuthParams`) and the REST wrapper (`makeSdkRestCall`,
// which takes a STRUCTURAL client) stay unit-testable with a fake — no live portal needed.
// Typing the constructed client as `OAuthCallClient` also acts as the compile-time drift
// guard: if a `@bitrix24/b24jssdk` minor/patch (Dependabot) renames/removes `actions` or
// `setCallbackRefreshAuth`, `typecheck:server` fails at that assignment rather than only
// on the live smoke-test.

import { B24OAuth } from '@bitrix24/b24jssdk'
import type { B24OAuthParams, B24OAuthSecret, CallbackRefreshAuth } from '@bitrix24/b24jssdk'
import type { RestCall } from './companyLookup'
import type { PortalToken } from './tokenStore'

/** B24 OAuth server endpoint (constant — the SDK refreshes tokens against it). */
const B24_SERVER_ENDPOINT = 'https://oauth.bitrix.info/rest/'

/** The slice of a B24 OAuth client this adapter uses — structural so tests inject a fake
 *  and the real `B24OAuth` satisfies it (checked where the client is constructed). */
export interface OAuthCallClient {
  actions: { v2: { call: { make: (o: { method: string, params?: Record<string, unknown> }) => Promise<SdkAjaxResult> } } }
  setCallbackRefreshAuth: (cb: CallbackRefreshAuth) => void
}

/** The bits of the SDK's `AjaxResult` we read. `getData()` returns the full REST
 *  envelope (`{ result, time, … }`), matching what our lookups expect from `RestCall`. */
export interface SdkAjaxResult {
  isSuccess: boolean
  getData: () => Record<string, unknown> | null | undefined
  getErrorMessages: () => string[]
}

/** Map our stored `PortalToken` to the SDK's `B24OAuthParams`. `nowMs` is passed in
 *  (not read from the clock) so the mapping is pure/testable. Fields we don't persist
 *  are defaulted: `userId` (0 — used only for the SDK's admin-init, not REST calls),
 *  `scope` (from `opts` or empty), `status` (`'L'` local app). `expires` is seconds. */
export function oauthParamsFromToken(token: PortalToken, opts: { nowMs: number, scope?: string }): B24OAuthParams {
  const domain = token.domain.trim()
  return {
    applicationToken: token.applicationToken,
    userId: 0,
    memberId: token.memberId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expires: Math.floor(token.expiresAt / 1000),
    expiresIn: Math.max(0, Math.floor((token.expiresAt - opts.nowMs) / 1000)),
    scope: opts.scope ?? '',
    domain,
    clientEndpoint: `https://${domain}/rest/`,
    serverEndpoint: B24_SERVER_ENDPOINT,
    status: 'L' // EnumAppStatus.Local — not consulted for REST calls
  }
}

/** Map the SDK's refreshed `B24OAuthParams` back to our `PortalToken` for persistence.
 *  `applicationToken` is preserved from params (write-once in the store regardless). */
export function tokenFromOAuthParams(p: B24OAuthParams): PortalToken {
  return {
    memberId: p.memberId,
    domain: p.domain,
    accessToken: p.accessToken,
    refreshToken: p.refreshToken,
    expiresAt: p.expires * 1000,
    applicationToken: p.applicationToken
  }
}

/** Build the refresh callback the SDK invokes after it renews the access token —
 *  persists the fresh token to our store so the next job/instance starts current. */
export function buildRefreshPersist(save: (t: PortalToken) => Promise<void>): CallbackRefreshAuth {
  return async ({ b24OAuthParams }) => {
    await save(tokenFromOAuthParams(b24OAuthParams))
  }
}

/** Wrap a B24 OAuth client as our `RestCall`: run the (rate-limited, auto-retried)
 *  call and unwrap the REST envelope, or throw the SDK's error messages. Throwing (not
 *  returning an error object) keeps the contract our lookups rely on — a failed call
 *  fails the crm-sync job for a clean retry, same as the hand-rolled `callRest`. */
export function makeSdkRestCall(client: OAuthCallClient): RestCall {
  return async (method, params) => {
    const res = await client.actions.v2.call.make({ method, params })
    if (!res.isSuccess) throw new Error(res.getErrorMessages().join('; ') || `B24 REST ${method} failed`)
    return (res.getData() ?? {}) as Record<string, unknown>
  }
}

/** I/O the portal-bound factory needs, injected for testability. The SDK client itself is
 *  NOT injected — this module owns `new B24OAuth(...)`; only its inputs (token store,
 *  creds, clock) come from the caller. */
export interface SdkPortalDeps {
  loadToken: (memberId: string) => Promise<PortalToken | null>
  saveToken: (token: PortalToken) => Promise<void>
  creds: B24OAuthSecret
  now: () => number
  scope?: string
}

/** Build a `RestCall` bound to one portal, backed by a per-portal `B24OAuth` instance
 *  (its own rate-limiter bucket) with refresh-persistence wired. `null` when the portal
 *  has no stored token — same contract as `makePortalRestCall`, so it's a drop-in swap
 *  for the crm-sync transport once verified on a live portal (`pnpm sdk:test`).
 *  NB: unlike `makePortalRestCall` (which calls `ensureFresh` PROACTIVELY before the
 *  first call), the SDK refreshes REACTIVELY — on the first `expired_token`/401 it
 *  refreshes and retries, costing one extra round-trip on the first call after expiry.
 *  Fine (the SDK handles it transparently), just not a pre-emptive refresh. */
export async function makePortalSdkCall(memberId: string, deps: SdkPortalDeps): Promise<RestCall | null> {
  const token = await deps.loadToken(memberId)
  if (!token) return null
  // Typing the instance as OAuthCallClient is the drift guard: the real B24OAuth must
  // still expose the `actions` / `setCallbackRefreshAuth` shape this adapter relies on.
  const client: OAuthCallClient = new B24OAuth(oauthParamsFromToken(token, { nowMs: deps.now(), scope: deps.scope }), deps.creds)
  client.setCallbackRefreshAuth(buildRefreshPersist(deps.saveToken))
  return makeSdkRestCall(client)
}
