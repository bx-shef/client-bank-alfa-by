// Pure OAuth 2.0 Authorization Code Grant helpers (RFC 6749). No I/O, no
// secrets at rest — just builds the URL/bodies and parses the callback, so the
// same contract is unit-tested here and reused by the backend token exchange.

/** Authorize + token endpoints for a provider. */
export interface OAuthEndpoints {
  authorizeUrl: string
  tokenUrl: string
}

/** Inputs for the browser-facing authorization request (step 1). */
export interface AuthorizeRequest {
  clientId: string
  redirectUri: string
  /** Requested scopes; joined with spaces per RFC 6749 §3.3. */
  scopes: readonly string[] | string
  /** Opaque CSRF value echoed back on the callback. */
  state: string
}

/** Successful token response (`/token`, RFC 6749 §5.1). */
export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

/** Parsed `redirect_uri` callback (step 2). */
export interface AuthorizationCallback {
  code?: string
  state?: string
  error?: string
  errorDescription?: string
}

function scopeString(scopes: readonly string[] | string): string {
  return Array.isArray(scopes) ? scopes.join(' ') : String(scopes)
}

/**
 * Build the `/authorize` URL the user opens in a browser (step 1).
 * `response_type=code` for the Authorization Code Grant.
 */
export function buildAuthorizeUrl(endpoints: OAuthEndpoints, req: AuthorizeRequest): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    scope: scopeString(req.scopes),
    state: req.state
  })
  return `${endpoints.authorizeUrl}?${params.toString()}`
}

/**
 * Form body for exchanging an authorization `code` for tokens (step 3).
 * `redirect_uri` must match the one used in `buildAuthorizeUrl`.
 */
export function buildAuthorizationCodeBody(params: {
  code: string
  redirectUri: string
}): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri
  })
}

/** Form body for refreshing an access token with a `refresh_token`. */
export function buildRefreshTokenBody(refreshToken: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  })
}

/**
 * HTTP Basic credentials header value for the token endpoint
 * (`Authorization: Basic …`, RFC 6749 §2.3.1).
 */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  // btoa-equivalent that also works in Node and the browser.
  const raw = `${clientId}:${clientSecret}`
  const b64 = typeof btoa === 'function'
    ? btoa(raw)
    : Buffer.from(raw, 'utf8').toString('base64')
  return `Basic ${b64}`
}

/**
 * Parse the `redirect_uri` the bank sends the user back to. Accepts a full URL
 * or a bare query string; surfaces both the success (`code`) and the RFC 6749
 * §4.1.2.1 error path.
 */
export function parseAuthorizationCallback(redirected: string): AuthorizationCallback {
  let search: string
  try {
    search = new URL(redirected).search
  } catch {
    // Not a full URL — treat the input as a raw query string.
    const q = redirected.indexOf('?')
    search = q >= 0 ? redirected.slice(q) : redirected
  }
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const out: AuthorizationCallback = {}
  const code = p.get('code')
  const state = p.get('state')
  const error = p.get('error')
  const errorDescription = p.get('error_description')
  if (code) out.code = code
  if (state) out.state = state
  if (error) out.error = error
  if (errorDescription) out.errorDescription = errorDescription
  return out
}
