// Pure OAuth 2.0 helpers for Alfa-Bank Belarus (partner.authorization 1.0.0).
// No I/O — builds the authorize URL and the token request bodies, and parses
// the token response. The HTTP transport + secret handling live in the engine
// (server), which reads config from env. Verified offline with unit tests;
// the live code↔token exchange runs from a Belarus-reachable host (the Alfa
// sandbox refuses TLS from other networks).
//
// Flow (Authorization Code): redirect the user to buildAuthorizeUrl() → Alfa
// calls back redirectUri with `?code=…&state=…` → exchange via the token body
// from buildTokenExchangeBody() → store tokens → refresh with buildRefreshBody().

/** Non-secret OAuth config (clientSecret is added only server-side at call time). */
export interface AlfaOAuthConfig {
  /** OAuth base, e.g. `https://developerhub.alfabank.by:8273` (sandbox) or
   * `https://ibapi2.alfabank.by:8273` (prod). No trailing slash. */
  baseUrl: string
  clientId: string
  redirectUri: string
  /** Space-separated scopes; default `accounts`. */
  scope?: string
}

const DEFAULT_SCOPE = 'accounts'

/**
 * Build the authorization URL the user is redirected to. `state` is an opaque
 * anti-CSRF value the caller generates and later verifies on the callback.
 */
export function buildAuthorizeUrl(config: AlfaOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    scope: config.scope ?? DEFAULT_SCOPE,
    redirect_uri: config.redirectUri,
    state
  })
  return `${config.baseUrl.replace(/\/+$/, '')}/authorize?${params.toString()}`
}

/**
 * Parse the OAuth callback query (Alfa redirects to
 * `redirectUri?code=…&state=…`). Verifies `state` matches the value we sent
 * (anti-CSRF) and that a code is present. The code is short-lived — exchange it
 * for tokens immediately. Throws on mismatch/missing/error.
 */
export function parseOAuthCallback(
  query: Record<string, string | string[] | undefined>,
  expectedState: string
): { code: string } {
  const get = (k: string): string | undefined => (Array.isArray(query[k]) ? query[k][0] : query[k]) as string | undefined

  const error = get('error')
  if (error) {
    throw new Error(`Alfa OAuth callback error: ${error}${get('error_description') ? ` — ${get('error_description')}` : ''}`)
  }
  const state = get('state')
  if (!state || state !== expectedState) {
    throw new Error('Alfa OAuth callback: state mismatch (possible CSRF)')
  }
  const code = get('code')
  if (!code) {
    throw new Error('Alfa OAuth callback: missing authorization code')
  }
  return { code }
}

/** Form body for exchanging an authorization `code` for tokens (`POST /token`). */
export function buildTokenExchangeBody(
  config: Pick<AlfaOAuthConfig, 'clientId' | 'redirectUri'>,
  code: string,
  clientSecret: string
): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: clientSecret
  })
}

/** Form body for refreshing tokens (`POST /token`, `grant_type=refresh_token`). */
export function buildRefreshBody(
  config: Pick<AlfaOAuthConfig, 'clientId'>,
  refreshToken: string,
  clientSecret: string
): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: clientSecret
  })
}

/** Normalized token set. `expiresAtMs` is computed from `expires_in`. */
export interface AlfaTokenSet {
  accessToken: string
  refreshToken: string
  tokenType: string
  /** Seconds the access token is valid for (Alfa: 3600). */
  expiresIn: number
}

/** Raw `POST /token` JSON shape. */
interface RawTokenResponse {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  error?: string
  error_description?: string
}

/**
 * Parse a `/token` JSON response into a typed token set. Throws with the OAuth
 * error description on an error payload or a missing access token.
 */
export function parseTokenResponse(raw: RawTokenResponse): AlfaTokenSet {
  if (raw.error) {
    throw new Error(`Alfa OAuth error: ${raw.error}${raw.error_description ? ` — ${raw.error_description}` : ''}`)
  }
  if (!raw.access_token || !raw.refresh_token) {
    throw new Error('Alfa OAuth: token response missing access_token/refresh_token')
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    tokenType: raw.token_type ?? 'Bearer',
    expiresIn: raw.expires_in ?? 3600
  }
}

/**
 * Whether an access token should be refreshed now, given when it was issued.
 * `skewMs` (default 60s) refreshes early to avoid using a token that expires
 * mid-request.
 */
export function isAccessTokenExpired(issuedAtMs: number, expiresIn: number, nowMs: number, skewMs = 60_000): boolean {
  return nowMs >= issuedAtMs + expiresIn * 1000 - skewMs
}
