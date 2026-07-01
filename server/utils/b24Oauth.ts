// Bitrix24 OAuth token refresh (server-side). Pure URL/parse helpers so the
// contract is unit-testable without hitting the network. Refreshing needs the
// APP's client_id/client_secret (env B24_CLIENT_ID / B24_CLIENT_SECRET) — the
// stored refresh_token alone isn't enough.

export const B24_OAUTH_TOKEN_URL = 'https://oauth.bitrix.info/oauth/token/'

export interface B24OAuthConfig {
  clientId: string
  clientSecret: string
}

/** Build the refresh-token request body (form-urlencoded). Creds go in the POST
 * body, NOT the URL — a query string would leak client_secret/refresh_token into
 * access logs (same rule as app/utils/alfaOauth.ts and docs/B24_EVENTS.md). */
export function buildRefreshBody(cfg: B24OAuthConfig, refreshToken: string): string {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken
  }).toString()
}

export interface B24RefreshResult {
  accessToken: string
  refreshToken: string
  /** Seconds until the access token expires (default 3600 if absent). */
  expiresIn: number
  memberId?: string
  /** REST base like `https://portal.bitrix24.by/rest/`, if returned. */
  clientEndpoint?: string
}

/** Parse the refresh response; throws if it carries no access_token (e.g. an
 * `{ error: ... }` body), so callers fail loud instead of storing empty tokens. */
export function parseRefreshResponse(json: unknown): B24RefreshResult {
  const o = (json ?? {}) as Record<string, unknown>
  const accessToken = typeof o.access_token === 'string' ? o.access_token : ''
  if (!accessToken) {
    const err = typeof o.error === 'string' ? o.error : 'no access_token in response'
    throw new Error(`b24 oauth refresh failed: ${err}`)
  }
  const expiresIn = Number(o.expires_in)
  return {
    accessToken,
    refreshToken: typeof o.refresh_token === 'string' ? o.refresh_token : '',
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    memberId: typeof o.member_id === 'string' ? o.member_id : undefined,
    clientEndpoint: typeof o.client_endpoint === 'string' ? o.client_endpoint : undefined
  }
}

/** Extract the bare host from a client_endpoint (`https://x.bitrix24.by/rest/` → `x.bitrix24.by`). */
export function hostFromEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined
  try {
    return new URL(endpoint).host
  } catch {
    return undefined
  }
}
