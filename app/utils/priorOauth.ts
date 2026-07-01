// Pure Open Banking (СПР) helpers for Priorbank Belarus — the OAuth/consent core
// shared by the sandbox script (scripts/prior-oauth-test.mjs) and, later, the
// backend engine. No I/O and no `node:crypto`: this module only *builds* request
// URLs / bodies / JWT claim-sets and *parses* responses. The HTTP transport, the
// RS256 signing of the authorize `request` JWT, and all secret handling live in
// the caller (script today, server tomorrow) — mirroring app/utils/alfaOauth.ts,
// which is likewise browser-safe and unit-tested.
//
// Flow (confirmed live against the sandbox — see docs/PRIOR_API.md):
//   token Б  (client_credentials, scope=accounts)  → POST /accountConsents
//   → openbanking_intent_id → GET /oauth2/authorize (signed `request` JWT)
//   → user logs in → code → exchange → token B → GET /accounts
//   → POST/GET /accounts/{id}/statements|transactions (async: create then poll).

/** СПР API path prefixes, per the bank's official guide. */
export const PRIOR_API_PREFIXES = {
  /** Authorize/token/revoke server. */
  AUTH: '/open-banking-authorize/v1.0',
  /** Dynamic Client Registration (RFC 7591). */
  DCR: '/open-banking-dcr/v1.0',
  /** Resource server (consents/accounts/statements/transactions). */
  OB: '/open-banking/v1.0'
} as const

/** Consent permissions we request — statements + transactions, income & outcome. */
export const CONSENT_PERMISSIONS = [
  'ReadAccountsBasic', 'ReadAccountsDetail', 'ReadBalances',
  'ReadStatementsBasic', 'ReadStatementsDetail',
  'ReadTransactionsBasic', 'ReadTransactionsDetail',
  'ReadTransactionsCredits', 'ReadTransactionsDebits'
] as const

/** A resource kind — the two async list endpoints share one create+poll shape. */
export type PriorResourceKind = 'statements' | 'transactions'

/** Days in a consent's default validity window (bank cap on the statement span
 * is 3 months; the consent itself we keep valid ~90 days). */
export const PRIOR_CONSENT_DEFAULT_DAYS = 90

/** Max statement/transaction window Priorbank accepts, in days (≈ 3 months). */
export const PRIOR_MAX_WINDOW_DAYS = 93

/**
 * HTTP Basic auth header value for the token endpoint (client_secret_basic, the
 * sandbox auth method). RFC 6749 §2.3.1. The secret only ever travels in this
 * header — never in a URL/body/log. Uses `btoa` (browser + Node ≥ 16 global);
 * ASCII client ids/secrets, as issued by DCR, are within its Latin-1 range.
 */
export function buildBasicAuthHeader(clientId: string, clientSecret: string): string {
  return 'Basic ' + btoa(`${clientId}:${clientSecret}`)
}

/** Form body for a `client_credentials` token (token А apim-scopes, or token Б
 * scope=accounts). Credentials go in the Basic auth header, not the body. */
export function buildClientCredentialsBody(scope: string): URLSearchParams {
  return new URLSearchParams({ grant_type: 'client_credentials', scope })
}

/** Form body exchanging an authorization `code` for token B. */
export function buildCodeExchangeBody(code: string, redirectUri: string): URLSearchParams {
  return new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
}

// NOTE: `buildPriorRefreshBody` / `buildPriorAuthorizeUrl` / `parsePriorTokenResponse`
// carry a `Prior` prefix because alfaOauth.ts exports the same generic names and
// Nuxt auto-imports app/utils/** into one namespace — the prefix keeps the two
// banks' OAuth cores from colliding there.

/** Form body refreshing token B. */
export function buildPriorRefreshBody(refreshToken: string): URLSearchParams {
  return new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
}

/** Inputs for the DCR registration metadata. */
export interface PriorRegistrationInput {
  clientName: string
  redirectUri: string
  /** Public JWK Set `{ keys: [...] }`; serialized to a STRING in the body (see below). */
  jwks?: unknown
}

/**
 * DCR `/register` body (RFC 7591 + OB fields). Two shapes a generic 500 hid on
 * the live run: `token_endpoint_auth_method` is an ARRAY, and `jwks` is a STRING
 * (a serialized JWK Set) — not an object. Only `redirect_uris` is truly required.
 */
export function buildRegistrationMetadata(input: PriorRegistrationInput): Record<string, unknown> {
  return {
    client_name: input.clientName,
    redirect_uris: [input.redirectUri],
    response_types: ['code', 'code id_token'],
    grant_types: ['authorization_code', 'client_credentials', 'refresh_token'],
    application_type: 'web',
    id_token_signed_response_alg: 'RS256',
    token_endpoint_auth_method: ['client_secret_basic'],
    ...(input.jwks ? { jwks: JSON.stringify(input.jwks) } : {})
  }
}

/** Inputs for a `/accountConsents` request. */
export interface PriorConsentInput {
  /** Consent validity — must be in the FUTURE. Distinct from the statement window. */
  expirationDate: string
  /** Optional statement window bounds (`yyyy-MM-dd`); may be in the past. */
  transactionFromDate?: string
  transactionToDate?: string
  /** Override the default permission set. */
  permissions?: readonly string[]
}

/** Body for `POST /accountConsents` — wrapped in `{ data: … }` as the API expects. */
export function buildConsentRequest(input: PriorConsentInput): { data: Record<string, unknown> } {
  return {
    data: {
      permissions: input.permissions ?? CONSENT_PERMISSIONS,
      expirationDate: input.expirationDate,
      ...(input.transactionFromDate ? { transactionFromDate: input.transactionFromDate } : {}),
      ...(input.transactionToDate ? { transactionToDate: input.transactionToDate } : {})
    }
  }
}

/** Inputs for the authorize `request` JWT claim-set. */
export interface PriorAuthorizeClaimsInput {
  clientId: string
  redirectUri: string
  intentId: string
  /** JWT audience — the token endpoint (issuer), from OIDC discovery. */
  aud: string
  nonce: string
  state: string
  /** `Math.floor(Date.now()/1000)` — supplied by the caller (keeps this pure). */
  nowSec: number
  jti: string
  /** Seconds until the JWT expires (default 600). */
  ttlSec?: number
  scope?: string
}

const DEFAULT_AUTHORIZE_SCOPE = 'openid accounts'

/**
 * The claim-set for the authorize `request` JWT. Pure payload only — the caller
 * RS256-signs it (node:crypto in the script, a server signer later). The
 * `openbanking_intent_id` claim binds the authorization to the consent.
 */
export function buildAuthorizeRequestClaims(input: PriorAuthorizeClaimsInput): Record<string, unknown> {
  const claim = { value: input.intentId, essential: true }
  return {
    client_id: input.clientId,
    sub: input.clientId,
    iss: input.clientId,
    response_type: 'code',
    nonce: input.nonce,
    state: input.state,
    redirect_uri: input.redirectUri,
    scope: input.scope ?? DEFAULT_AUTHORIZE_SCOPE,
    aud: [input.aud],
    claims: {
      userinfo: { openbanking_intent_id: claim },
      id_token: { openbanking_intent_id: claim }
    },
    iat: input.nowSec,
    exp: input.nowSec + (input.ttlSec ?? 600),
    jti: input.jti
  }
}

/** Inputs for the authorize URL query. */
export interface PriorAuthorizeUrlInput {
  clientId: string
  redirectUri: string
  state: string
  /** The signed `request` JWT (built from buildAuthorizeRequestClaims + a signer). */
  requestJwt: string
  scope?: string
}

/**
 * Build the `GET /oauth2/authorize` URL the user is redirected to. `base` is the
 * gateway origin (no trailing slash); the AUTH prefix is applied here. Throws if
 * `base` is empty (would yield a relative, broken URL).
 */
export function buildPriorAuthorizeUrl(base: string, input: PriorAuthorizeUrlInput): string {
  if (!base) throw new Error('priorOauth.buildPriorAuthorizeUrl: base is required')
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scope ?? DEFAULT_AUTHORIZE_SCOPE,
    prompt: 'login',
    state: input.state,
    request: input.requestJwt
  })
  return `${base.replace(/\/+$/, '')}${PRIOR_API_PREFIXES.AUTH}/oauth2/authorize?${q.toString()}`
}

/**
 * Body for creating a statement/transaction list. Both are the same async shape,
 * differing only in the resource key and the date format (both confirmed live):
 *  - statements   want a bare `yyyy-MM-dd`
 *  - transactions want a full ISO datetime with the +03:00 (Belarus) offset
 * `from`/`to` are `yyyy-MM-dd`.
 */
export function buildResourceRequestBody(
  kind: PriorResourceKind,
  from: string,
  to: string
): { data: Record<string, { fromBookingDate: string, toBookingDate: string }> } {
  const key = kind === 'transactions' ? 'transaction' : 'statement'
  const fromBookingDate = kind === 'transactions' ? `${from}T00:00:00+03:00` : from
  const toBookingDate = kind === 'transactions' ? `${to}T23:59:59+03:00` : to
  return { data: { [key]: { fromBookingDate, toBookingDate } } }
}

/** Whether a `yyyy-MM-dd` window is within Priorbank's ≈3-month cap. Invalid or
 * inverted dates return `false` (treated as out of range — the caller warns). */
export function isWindowWithinLimit(from: string, to: string): boolean {
  const f = Date.parse(from)
  const t = Date.parse(to)
  if (!Number.isFinite(f) || !Number.isFinite(t) || t < f) return false
  return (t - f) / 864e5 <= PRIOR_MAX_WINDOW_DAYS
}

/** Normalized token set (mirrors AlfaTokenSet — one app-facing token shape). */
export interface PriorTokenSet {
  accessToken: string
  refreshToken?: string
  tokenType: string
  expiresIn: number
  scope?: string
}

/** Raw `/oauth2/token` JSON shape. */
interface RawPriorTokenResponse {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

/**
 * Parse a `/oauth2/token` JSON response into a typed token set. Throws with the
 * OAuth error description on an error payload or a missing access token.
 * `refresh_token` is absent for `client_credentials` (token А/Б) — hence optional.
 */
export function parsePriorTokenResponse(raw: RawPriorTokenResponse): PriorTokenSet {
  if (raw.error) {
    throw new Error(`Priorbank OAuth error: ${raw.error}${raw.error_description ? ` — ${raw.error_description}` : ''}`)
  }
  if (!raw.access_token) {
    throw new Error('Priorbank OAuth: token response missing access_token')
  }
  return {
    accessToken: raw.access_token,
    ...(raw.refresh_token ? { refreshToken: raw.refresh_token } : {}),
    tokenType: raw.token_type ?? 'Bearer',
    expiresIn: raw.expires_in ?? 3600,
    ...(raw.scope ? { scope: raw.scope } : {})
  }
}

/** Unwrap the `{ data: … }` envelope the resource API wraps responses in. */
function unwrapData(response: unknown): Record<string, unknown> {
  if (response && typeof response === 'object') {
    const obj = response as Record<string, unknown>
    if (obj.data && typeof obj.data === 'object') return obj.data as Record<string, unknown>
    return obj
  }
  return {}
}

/**
 * Pull the consent intent id out of a `/accountConsents` response. The field
 * name varies by revision (consentId / accountConsentId / openbanking_intent_id
 * / ConsentId) — accept any. Returns `null` if none is present.
 */
export function extractIntentId(response: unknown): string | null {
  const d = unwrapData(response)
  const id = d.consentId || d.accountConsentId || d.openbanking_intent_id || d.ConsentId
  return id ? String(id) : null
}

/**
 * Pull the created resource id (statementId / transactionListId, or a generic
 * `id`) out of a create-statement/transaction response. Returns `null` if none.
 */
export function extractResourceId(kind: PriorResourceKind, response: unknown): string | null {
  const key = kind === 'transactions' ? 'transaction' : 'statement'
  const idKey = kind === 'transactions' ? 'transactionListId' : 'statementId'
  const d = unwrapData(response)
  const node = (d[key] && typeof d[key] === 'object' ? d[key] as Record<string, unknown> : d)
  const id = node[idKey] || node.id
  return id ? String(id) : null
}

/** A minimally-shaped account row from `GET /accounts`. */
export interface PriorAccountRef {
  accountId: string
  currency?: string
  /** IBAN / identification, when present. */
  identification?: string
  accountSubType?: string
}

/**
 * Extract the account list from a `GET /accounts` response into a stable shape.
 * Tolerates the `data.account` / `data.accounts` / bare-array variants and the
 * accountId / AccountId casing seen across revisions.
 */
export function extractAccounts(response: unknown): PriorAccountRef[] {
  const d = unwrapData(response)
  const rawList = (d.account || d.accounts || (Array.isArray(response) ? response : [])) as unknown
  if (!Array.isArray(rawList)) return []
  const str = (v: unknown): string | undefined => (v == null ? undefined : String(v))
  return rawList.map((a) => {
    const acc = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
    const details = acc.accountDetails
    const iban = (details && typeof details === 'object' ? (details as Record<string, unknown>).identification : undefined)
      ?? acc.iban ?? acc.identification ?? acc.number
    return {
      accountId: str(acc.accountId ?? acc.AccountId) ?? '',
      currency: str(acc.currency ?? acc.currIso),
      identification: str(iban),
      accountSubType: str(acc.accountSubType)
    }
  }).filter(a => a.accountId)
}
