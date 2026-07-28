// Priorbank connect-start orchestration (A5b, slice 2b) — the multi-step preamble Alfa does not
// have. Alfa's authorize URL is a pure string build (client_id + redirect + state); Prior needs a
// live round-trip BEFORE the user can be sent anywhere:
//
//   1. token Б   — POST /oauth2/token, grant_type=client_credentials, scope=accounts
//                  (client_secret_basic: creds in the Authorization header, never the body/URL)
//   2. consent   — POST /open-banking/v1.0/accountConsents  → openbanking_intent_id
//   3. request   — RS256-sign the authorize claim-set (binds the intent id)   [priorJwt.ts]
//   4. authorize — GET /oauth2/authorize?…&request=<JWT>     → the URL the admin opens
//
// Everything pure (bodies, claim-set, URL) comes from the tested core app/utils/priorOauth.ts;
// the transport + signing + clock + ids are INJECTED, so this orchestration is unit-testable
// without network or crypto. Secrets (client_secret, private key) are only ever passed to the
// injected transport/signer — never returned, logged, or embedded in the URL.
//
// The caller (the connect route, slice 2c) owns portal resolution, the admin gate and the signed
// connect-state — identical to the Alfa path (bankConnectStart.ts); this module only produces the
// bank-side authorize URL.

import {
  buildAuthorizeRequestClaims,
  buildClientCredentialsBody,
  buildConsentRequest,
  buildPriorAuthorizeUrl,
  extractIntentId,
  parsePriorTokenResponse,
  PRIOR_API_PREFIXES
} from '../../app/utils/priorOauth'

/** Non-secret Prior connect config (from env) + the secrets the injected transport needs. */
export interface PriorConnectConfig {
  /** Gateway origin, e.g. `https://api.priorbank.by:9344` (no trailing slash). */
  baseUrl: string
  /** Business-app client id (from DCR). */
  clientId: string
  /** Business-app client secret (from DCR) — client_secret_basic. */
  clientSecret: string
  /** Registered redirect URI — must EXACTLY match the DCR-registered value. */
  redirectUri: string
  /** JWT `aud` — the issuer / token endpoint from /oidcdiscovery (port 9544, not 9344). */
  audience: string
  /** RS256 private key (PEM) whose public half is registered in the app's `jwks`. */
  privateKeyPem: string
  /** Key id matching the `kid` published in `jwks`. */
  kid: string
}

/** Read the Prior connect config from env. Returns `null` when ANY required part is unset —
 *  fail-closed, so an unconfigured provider yields a clean 400 instead of a broken authorize URL
 *  (mirrors `bankConnectConfigFromEnv` for Alfa). */
export function priorConnectConfigFromEnv(): PriorConnectConfig | null {
  const baseUrl = process.env.PRIOR_OAUTH_API_BASE?.trim().replace(/\/+$/, '')
  const clientId = process.env.PRIOR_OAUTH_CLIENT_ID?.trim()
  const clientSecret = process.env.PRIOR_OAUTH_CLIENT_SECRET?.trim()
  const redirectUri = process.env.PRIOR_OAUTH_REDIRECT_URI?.trim()
  const audience = process.env.PRIOR_OAUTH_AUDIENCE?.trim()
  const privateKeyPem = process.env.PRIOR_OAUTH_PRIVATE_KEY?.trim()
  const kid = process.env.PRIOR_OAUTH_KID?.trim()
  if (!baseUrl || !clientId || !clientSecret || !redirectUri || !audience || !privateKeyPem || !kid) return null
  // Must be an absolute http(s) origin, else buildPriorAuthorizeUrl would emit a broken URL.
  if (!/^https?:\/\/[^/]/.test(baseUrl)) return null
  return { baseUrl, clientId, clientSecret, redirectUri, audience, privateKeyPem, kid }
}

/** Injected side-effects, so the orchestration is testable without network/crypto/clock. */
export interface PriorConnectDeps {
  /** POST a form body to the Prior token endpoint with client_secret_basic auth; returns raw JSON.
   *  The secret goes in the Authorization header (built by the impl), never the body. */
  postToken: (url: string, body: string, creds: { clientId: string, clientSecret: string }) => Promise<unknown>
  /** POST the consent JSON with the token-Б Bearer; returns raw JSON. */
  postConsent: (url: string, accessToken: string, body: unknown) => Promise<unknown>
  /** RS256-sign the authorize claim-set (server/utils/priorJwt.ts signPriorJwt). */
  signJwt: (payload: Record<string, unknown>, privateKeyPem: string, kid: string) => string
  /** Epoch SECONDS (JWT iat/exp). */
  nowSec: () => number
  /** Fresh random ids for the JWT `jti` and the OIDC `nonce`. */
  newId: () => string
}

/** Consent scope for token Б (the client_credentials token that creates the consent). */
export const PRIOR_CONSENT_SCOPE = 'accounts'

/** How long the created consent stays valid. The bank requires `expirationDate` to be in the
 *  FUTURE (it is the consent's lifetime, NOT the statement window) — 90 days keeps the connected
 *  account polling without re-consent for a quarter. */
export const PRIOR_CONSENT_DAYS = 90

/** Build the consent `expirationDate` (`yyyy-MM-dd`) `days` ahead of `nowMs`. Pure. */
export function priorConsentExpiry(nowMs: number, days = PRIOR_CONSENT_DAYS): string {
  return new Date(nowMs + days * 864e5).toISOString().slice(0, 10)
}

/**
 * Run the Prior connect preamble and return the authorize URL the admin must open.
 * `state` is the caller's already-signed connect state (opaque here — it round-trips through the
 * bank back to our callback). Throws with a clean message on any step failure (no secrets in the
 * message) so the route can map it to a 502 — it never returns a half-built URL.
 */
export async function buildPriorConnectUrl(
  config: PriorConnectConfig,
  state: string,
  deps: PriorConnectDeps,
  nowMs: number
): Promise<string> {
  const tokenUrl = `${config.baseUrl}${PRIOR_API_PREFIXES.AUTH}/oauth2/token`
  const consentUrl = `${config.baseUrl}${PRIOR_API_PREFIXES.OB}/accountConsents`

  // 1) token Б (client_credentials, scope=accounts) — creds travel in the Basic header.
  const tokenRaw = await deps.postToken(
    tokenUrl,
    buildClientCredentialsBody(PRIOR_CONSENT_SCOPE).toString(),
    { clientId: config.clientId, clientSecret: config.clientSecret }
  )
  // parsePriorTokenResponse throws on an OAuth error payload / missing access_token.
  const tokenB = parsePriorTokenResponse(tokenRaw as never)

  // 2) consent → openbanking_intent_id.
  const consentRaw = await deps.postConsent(
    consentUrl,
    tokenB.accessToken,
    buildConsentRequest({ expirationDate: priorConsentExpiry(nowMs) })
  )
  const intentId = extractIntentId(consentRaw)
  if (!intentId) throw new Error('priorConnect: consent response carried no intent id')

  // 3) sign the authorize `request` JWT (binds the consent to the authorization).
  const claims = buildAuthorizeRequestClaims({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    intentId,
    aud: config.audience,
    nonce: deps.newId(),
    state,
    nowSec: deps.nowSec(),
    jti: deps.newId()
  })
  const requestJwt = deps.signJwt(claims, config.privateKeyPem, config.kid)

  // 4) the authorize URL the admin opens top-level.
  return buildPriorAuthorizeUrl(config.baseUrl, {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    state,
    requestJwt
  })
}
