// Install-time member_id binding (#162). The first ONAPPINSTALL delivers member_id as a
// CLIENT-CONTROLLED field, verified only against the application_token (an app-level secret every
// install of this app receives). So an attacker who installed the real app on THEIR OWN portal holds
// a valid application_token and can forge an install carrying a VICTIM's member_id + their own OAuth
// grant → the victim's member_id gets bound to attacker creds (targeted install-poisoning DoS).
//
// We bind by refreshing the DELIVERED refresh_token: the OAuth token endpoint returns the
// AUTHORITATIVE member_id of that grant, which must equal the claimed one. An attacker can only
// present a refresh_token for a portal they control, so its authoritative member_id won't match the
// victim's claim → 403. Refresh ROTATES the token, so on success the caller MUST store the RETURNED
// grant (the delivered refresh_token is now spent).
//
// DELIBERATE non-SDK exception (crm-sync goes through @bitrix24/b24jssdk): the SDK's refreshAuth
// DISCARDS the response's member_id, so it cannot surface the authoritative id. This one raw OAuth
// token POST is the only way to read it. Host is FIXED (oauth.bitrix.info — not client-controlled →
// no SSRF), secrets ride in the POST body (never the URL → no access-log leak), AbortSignal-bounded.

import { buildRefreshBody, parseRefreshResponse, type B24OAuthConfig, type B24RefreshResult } from './b24Oauth'
import { withDependencySpan } from './telemetrySpan'

/** B24 OAuth token endpoint. FIXED host (not derived from client input) — no SSRF surface. Mirrors
 *  the SDK's own refresh server, so install-time and steady-state refreshes hit the same OAuth host. */
const OAUTH_TOKEN_URL = 'https://oauth.bitrix.info/oauth/token/'

/** Hard timeout on the install-verify OAuth POST — a hung OAuth connection must not stall the
 *  webhook (B24 has its own delivery timeout; we fail-closed to 503 rather than hang). */
export const INSTALL_VERIFY_TIMEOUT_MS = 15_000

/** OAuth error CODES that mean the presented refresh_token is not a genuine grant ⇒ the install is
 *  forged ⇒ 403. Anything else (e.g. `wrong_client`/`invalid_client` — OUR config, or a transient
 *  upstream) is treated as "cannot verify now" ⇒ 503 (retryable, fail-closed either way).
 *
 *  Intentionally NARROWER than ai-price-import's shared `isAuthRejection` regex: the 403↔503 split is
 *  NOT a security boundary here — both refuse to persist the install — so an unlisted code falling to
 *  503 (retryable) is the safe direction, and a genuinely forged grant returns `invalid_grant` anyway.
 *  Kept as an explicit small set to avoid depending on the broader classifier for a non-boundary. */
const GRANT_REJECTION_CODES = new Set(['invalid_grant', 'invalid_token', 'expired_token'])

/** Minimal fetch surface (injected → unit-testable without the network). */
export type OAuthFetchFn = (
  url: string,
  init: { method: string, headers: Record<string, string>, body: string, signal?: AbortSignal }
) => Promise<{ json: () => Promise<unknown> }>

/** Build the raw OAuth token-refresh transport (the ONE sanctioned non-SDK B24 call — see header).
 *  Creds are baked in from `cfg`; the returned fn takes the refresh_token and yields parsed JSON. */
export function rawOauthRefresh(fetchFn: OAuthFetchFn, cfg: B24OAuthConfig, timeoutMs = INSTALL_VERIFY_TIMEOUT_MS): (refreshToken: string) => Promise<unknown> {
  // Span timing/outcome of the install-time OAuth POST (#162, #78). The body (client_secret/
  // refresh_token) is NEVER attached to the span — only system/operation/method.
  return refreshToken => withDependencySpan(
    { system: 'bitrix24', operation: 'oauth.install-verify', method: 'oauth.refresh' },
    async () => {
      const res = await fetchFn(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildRefreshBody(cfg, refreshToken),
        signal: AbortSignal.timeout(timeoutMs)
      })
      return res.json()
    }
  )
}

export interface InstallMemberDeps {
  /** Performs the OAuth token refresh with the given refresh_token, returns the parsed JSON. */
  refresh: (refreshToken: string) => Promise<unknown>
}

/** The rotated grant returned by a successful bind — the caller MUST store THIS (not the delivered
 *  creds): refreshing rotated the token, so the delivered refresh_token is now stale. `refreshToken`
 *  is plaintext; the caller encrypts it before persistence. */
export interface RefreshedGrant {
  accessToken: string
  refreshToken: string
  clientEndpoint: string
  expiresIn: number
}

export interface InstallMemberResult {
  ok: boolean
  /** 403 = member_id rejected (spoofed / forged grant); 503 = cannot verify now (network/config). */
  status?: 403 | 503
  grant?: RefreshedGrant
}

/** Verify the claimed install member_id against the authoritative one from the OAuth grant (#162).
 *  Refreshes the delivered refresh_token, compares the returned member_id, and hands back the
 *  ROTATED grant to store. Fail-closed: any doubt (network/config/no member_id) → 503, explicit
 *  mismatch or a rejected/forged grant → 403. Never throws. */
export async function verifyInstallMember(claimedMemberId: string, refreshToken: string, deps: InstallMemberDeps): Promise<InstallMemberResult> {
  const claimed = claimedMemberId.trim().toLowerCase()
  // No claimed id or no refresh token ⇒ nothing to bind against ⇒ reject (fail closed).
  if (!claimed || !refreshToken) return { ok: false, status: 403 }
  let raw: unknown
  try {
    raw = await deps.refresh(refreshToken)
  } catch {
    return { ok: false, status: 503 } // transport / network — cannot verify now
  }
  // Coerce non-objects to {} BEFORE the `in` operator — a JSON primitive (a misconfigured proxy
  // returning a bare string/number) would make `'error' in <primitive>` throw, escaping the
  // fail-closed contract and 500-ing the webhook. A primitive then fails parseRefreshResponse → 503.
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  // An OAuth ERROR body (an `error` code with NO usable access_token): classify by the machine CODE —
  // a bad grant ⇒ forged install → 403; our-config / transient ⇒ 503. Gate on the ABSENCE of an
  // access_token (not merely the `error` key's presence) so a success body that spuriously carries
  // `error: null`/'' alongside real tokens is not false-rejected — it falls through to parse+compare.
  if ('error' in o && !o.access_token) {
    return { ok: false, status: GRANT_REJECTION_CODES.has(String(o.error)) ? 403 : 503 }
  }
  let parsed: B24RefreshResult
  try {
    parsed = parseRefreshResponse(raw)
  } catch {
    return { ok: false, status: 503 } // malformed success (no access_token) — cannot verify
  }
  const authoritative = String(parsed.memberId ?? '').trim().toLowerCase()
  // A genuine grant always echoes member_id; empty ⇒ cannot bind ⇒ 503 (don't false-reject a real install).
  if (!authoritative) return { ok: false, status: 503 }
  // The token belongs to a DIFFERENT portal than the event claims ⇒ forged install → 403.
  if (authoritative !== claimed) return { ok: false, status: 403 }
  return {
    ok: true,
    grant: {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      clientEndpoint: parsed.clientEndpoint || '',
      expiresIn: parsed.expiresIn
    }
  }
}
