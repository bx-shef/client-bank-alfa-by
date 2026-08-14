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

/**
 * Consent permissions we request — accounts + statements + transactions, income & outcome.
 *
 * ⚠ THE CLIENT SEES THIS LIST on the bank's consent screen, and it is their money, so every entry
 * has to earn its place. `ReadBalances` was dropped: we never read a balance anywhere — the import
 * is a list of operations, and a current balance is neither shown nor stored. Asking for it bought
 * nothing and cost trust at exactly the moment the client is deciding whether to grant access.
 *
 * `ReadStatements*` is KEPT even though the poller currently pulls `transactions`
 * (`RESOURCE_KIND` in server/utils/priorFetch.ts). The two endpoints share one create+poll shape,
 * and only the `statements` response form has been confirmed against the live bank — if
 * `transactions` turns out to be shaped differently we fall back to `statements`. Dropping the
 * permission would make that fallback cost a NEW consent, i.e. asking the account holder to log in
 * and authorise a second time. Narrowing it further is only safe once `transactions` is confirmed
 * live (issue #461).
 */
export const CONSENT_PERMISSIONS = [
  'ReadAccountsBasic', 'ReadAccountsDetail',
  'ReadStatementsBasic', 'ReadStatementsDetail',
  'ReadTransactionsBasic', 'ReadTransactionsDetail',
  'ReadTransactionsCredits', 'ReadTransactionsDebits'
] as const

/**
 * FAPI correlation header. The bank REQUIRES it on every Open Banking resource call and rejects
 * the request outright without it:
 *
 *   400 BY.NBRB.Header.Missing — Required request header 'x-fapi-interaction-id' … is not present
 *
 * Measured against the sandbox, 2026-08-12. It is NOT sent on the token endpoint — only on the
 * `/open-banking/v1.0/…` resource server (consents, accounts, statements, transactions).
 */
export const PRIOR_FAPI_INTERACTION_HEADER = 'x-fapi-interaction-id'

/**
 * Second mandatory header, on WRITES only. The bank rejects any resource POST without it, with the
 * same shape as the missing FAPI header:
 *
 *   400 BY.NBRB.Header.Missing — Required request header 'x-idempotency-key' … is not present
 *
 * Measured against the sandbox, 2026-08-12 (four different consent bodies, identical rejection —
 * so the header is checked BEFORE the body is looked at).
 */
export const PRIOR_IDEMPOTENCY_HEADER = 'x-idempotency-key'

/**
 * Headers for ONE Open Banking resource READ. Single choke point on purpose: the resource API is
 * reached from four separate transports (consent in the connect preamble, plus create/list/poll in
 * the poller), and a header that has to be remembered in four places is a header that will be
 * missing from one of them — which is exactly how this surfaced, twice, as an opaque 502 at connect.
 *
 * `interactionId` is supplied by the caller (a fresh UUID per request): this module stays
 * browser-safe and must not reach for `node:crypto`. FAPI expects the server to echo it back, so
 * it doubles as the correlation id to quote when asking the bank about a specific failure.
 */
export function priorResourceHeaders(accessToken: string, interactionId: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    [PRIOR_FAPI_INTERACTION_HEADER]: interactionId
  }
}

/**
 * Headers for ONE Open Banking resource WRITE (consent creation, statement/transaction resource
 * creation). Separate from {@link priorResourceHeaders} rather than an optional flag on it so the
 * idempotency key cannot be forgotten at a call site: a write is unbuildable without one.
 *
 * A FRESH key per call preserves today's semantics exactly — every attempt creates a new resource,
 * which is what the code did when it sent no key at all. Deriving a STABLE key from (account,
 * window) would additionally make a retried poll collapse onto one bank-side resource; that is a
 * behaviour change and needs a live run to confirm, so it is deliberately not done here.
 */
export function priorWriteHeaders(
  accessToken: string,
  interactionId: string,
  idempotencyKey: string
): Record<string, string> {
  return {
    ...priorResourceHeaders(accessToken, interactionId),
    [PRIOR_IDEMPOTENCY_HEADER]: idempotencyKey,
    'content-type': 'application/json'
  }
}

/** A resource kind — the two async list endpoints share one create+poll shape. */
export type PriorResourceKind = 'statements' | 'transactions'

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

/**
 * How the app authenticates ITSELF at the token endpoint (`token_endpoint_auth_method`).
 * Per the bank's guide (p. 9 §2.2) `client_secret_basic`/`client_secret_post` are
 * **sandbox-only**; production accepts `private_key_jwt`, `tls_client_auth` and
 * `self_signed_tls_client_auth`. We implement `private_key_jwt` — the only one of the three
 * needing neither mutual TLS nor an X.509 client certificate (and therefore no ГосСУОК).
 *
 * ⚠ WE register exactly one method per application (the bank's guide allows several — p. 9 §2.2 —
 * but a single one keeps the wire format unambiguous). So ALL token-endpoint calls must use the
 * same one — see `priorTokenRequest` callers (four sites, docs/PRIOR_API.md).
 */
export type PriorTokenAuthMethod = 'client_secret_basic' | 'private_key_jwt'

/** Valid `token_endpoint_auth_method` values we support (for coercion + tests). */
export const PRIOR_TOKEN_AUTH_METHODS: readonly PriorTokenAuthMethod[] = ['client_secret_basic', 'private_key_jwt']

/**
 * Coerce a configured method name, defaulting to the sandbox one. Fail-SAFE rather than
 * fail-closed on purpose: an unknown/blank value keeps today's working sandbox behaviour
 * instead of silently arming a prod method the app may not be registered for.
 *
 * ⚠ A TYPO is not the same as «unset». Blank ⇒ the sandbox default is the intended behaviour;
 * a non-empty value we don't recognise (`private-key-jwt`, trailing character…) means someone
 * MEANT to configure something and it didn't take — in production that silently sends Basic to a
 * client registered for private_key_jwt and yields opaque 401s with nothing pointing at the cause.
 * `onUnknown` lets callers surface it (the server logs a warning, `envCheck` reports it at boot);
 * the returned value is the safe default either way, so pure callers can ignore it.
 */
export function parsePriorAuthMethod(
  raw: string | null | undefined,
  onUnknown?: (rawValue: string) => void
): PriorTokenAuthMethod {
  const v = (raw ?? '').trim()
  if ((PRIOR_TOKEN_AUTH_METHODS as readonly string[]).includes(v)) return v as PriorTokenAuthMethod
  if (v) onUnknown?.(v)
  return 'client_secret_basic'
}

/** RFC 7523 assertion type — the fixed `client_assertion_type` value (guide §4.1.2). */
export const PRIOR_CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** Lifetime of a `client_assertion` JWT. Short — it is single-use, minted per request. */
export const PRIOR_ASSERTION_TTL_SEC = 300

/** Inputs for the `client_assertion` JWT claim-set (private_key_jwt). */
export interface PriorClientAssertionInput {
  clientId: string
  /** JWT audience — the issuer / token endpoint from `/oidcdiscovery` (port 9544). The SAME
   *  value the authorize `request` JWT uses (`PRIOR_OAUTH_AUDIENCE`). */
  aud: string
  /** `Math.floor(Date.now()/1000)` — supplied by the caller (keeps this pure). */
  nowSec: number
  jti: string
  /** Seconds until the JWT expires (default `PRIOR_ASSERTION_TTL_SEC`). */
  ttlSec?: number
}

/**
 * Claim-set for the `client_assertion` JWT (private_key_jwt, guide §4.1.2). Pure payload —
 * the caller RS256-signs it with the key whose public half is registered in `jwks`.
 *
 * ⚠ NOT the same JWT as `buildAuthorizeRequestClaims`: that one is the `request` parameter of
 * `/oauth2/authorize` and carries `openbanking_intent_id`; this one proves WHO we are at
 * `/oauth2/token`. Both are RS256 over the same key — don't conflate them.
 *
 * Shape follows the bank's documented example verbatim: `aud` is an ARRAY, `iss` and `sub` are
 * both the client id, and the client id is NOT sent as a separate body param (it rides in these
 * claims).
 */
export function buildClientAssertionClaims(input: PriorClientAssertionInput): Record<string, unknown> {
  return {
    iss: input.clientId,
    sub: input.clientId,
    aud: [input.aud],
    iat: input.nowSec,
    exp: input.nowSec + (input.ttlSec ?? PRIOR_ASSERTION_TTL_SEC),
    jti: input.jti
  }
}

/** How to authenticate ONE token request — creds for Basic, or an already-signed assertion. */
export type PriorTokenAuth
  = | { method: 'client_secret_basic', clientId: string, clientSecret: string }
    | { method: 'private_key_jwt', assertion: string }

/**
 * Apply the client-authentication method to a token-endpoint request: returns the final form
 * body plus the headers it needs. `client_secret_basic` puts the creds in the Authorization
 * HEADER (never the body); `private_key_jwt` appends `client_assertion` +
 * `client_assertion_type` to the BODY and needs no header. The caller's `body` is not mutated.
 *
 * Single choke point for all four token-endpoint call sites, so the method can't drift between
 * them (DCR registers one method per app — a mismatch is a 401 at whichever site was missed).
 */
export function priorTokenRequest(
  body: URLSearchParams,
  auth: PriorTokenAuth
): { body: string, headers: Record<string, string> } {
  if (auth.method === 'private_key_jwt') {
    if (!auth.assertion) throw new Error('priorTokenRequest: private_key_jwt requires a signed client_assertion')
    const withAssertion = new URLSearchParams(body)
    withAssertion.set('client_assertion_type', PRIOR_CLIENT_ASSERTION_TYPE)
    withAssertion.set('client_assertion', auth.assertion)
    return { body: withAssertion.toString(), headers: {} }
  }
  return {
    body: body.toString(),
    headers: { authorization: buildBasicAuthHeader(auth.clientId, auth.clientSecret) }
  }
}

/** Form body for a `client_credentials` token (token А apim-scopes, or token Б
 * scope=accounts). Client authentication is applied separately by `priorTokenRequest`. */
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
  /**
   * Client-authentication method to register. Defaults to `client_secret_basic` (sandbox).
   * **Production requires `private_key_jwt`** — `client_secret_basic` is sandbox-only
   * (guide p. 9 §2.2). Whatever is registered here MUST match what every token-endpoint
   * call sends, so change it together with `PRIOR_OAUTH_AUTH_METHOD`.
   */
  tokenEndpointAuthMethod?: PriorTokenAuthMethod
}

/**
 * DCR `/register` body (RFC 7591 + OB fields). Two shapes a generic 500 hid on
 * the live run: `token_endpoint_auth_method` is an ARRAY, and `jwks` is a STRING
 * (a serialized JWK Set) — not an object. Only `redirect_uris` is truly required.
 *
 * `jwks` is required by the bank when `grant_types` contains `authorization_code` (always, for
 * us) — and it is ALSO what `private_key_jwt` verifies the `client_assertion` against, so the
 * same registered key serves both.
 *
 * ⚠ `request_object_signing_alg` is NOT optional here, and its absence is invisible until the very
 * last step. Registration succeeds, `client_credentials` succeeds, `POST /accountConsents` returns
 * `201` — and then `GET /oauth2/authorize` bounces the account holder back with
 * `error=invalid_request_object&error_description=server_error`, AFTER they have already been sent
 * to their bank. The bank publishes exactly one accepted value (`request_object_signing_alg_values_supported: ['RS256']`,
 * read live from `/oidcdiscovery`) but will not assume it: a client that never declared how it
 * signs gets its signed `request` JWT refused. Registering `id_token_signed_response_alg` alone is
 * NOT the same declaration — that one covers the id_token the bank issues to us, this one covers
 * the request object we send to the bank, and we shipped the first without the second. Measured
 * against the sandbox, 2026-08-14 (docs/PRIOR_API.md).
 */
export function buildRegistrationMetadata(input: PriorRegistrationInput): Record<string, unknown> {
  return {
    client_name: input.clientName,
    redirect_uris: [input.redirectUri],
    response_types: ['code', 'code id_token'],
    grant_types: ['authorization_code', 'client_credentials', 'refresh_token'],
    application_type: 'web',
    id_token_signed_response_alg: 'RS256',
    request_object_signing_alg: 'RS256',
    token_endpoint_auth_method: [input.tokenEndpointAuthMethod ?? 'client_secret_basic'],
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

/** The resource path prefix for a create/poll call: `<OB>/accounts/{accountId}/{kind}`.
 *  `kind` (`statements`|`transactions`) is the trailing segment. Used for the async CREATE
 *  (`POST`, no resource id) — the poll path appends the id (see `buildPriorResourcePollPath`). */
export function buildPriorResourceCreatePath(kind: PriorResourceKind, accountId: string): string {
  return `${PRIOR_API_PREFIXES.OB}/accounts/${accountId}/${kind}`
}

/** The poll path for a created resource: `<OB>/accounts/{accountId}/{kind}/{resourceId}` —
 *  `GET`-polled until ready (200) or `BY.NBRB.Resource.NotCreated` while still generating. */
export function buildPriorResourcePollPath(kind: PriorResourceKind, accountId: string, resourceId: string): string {
  return `${buildPriorResourceCreatePath(kind, accountId)}/${resourceId}`
}

/** The error code Priorbank returns from the poll GET while the async resource is still being
 *  generated — the signal to wait and poll again (NOT a hard failure). */
export const PRIOR_RESOURCE_NOT_CREATED = 'BY.NBRB.Resource.NotCreated'

/** Pull error codes out of a Priorbank response envelope, tolerant of the shapes seen across
 *  revisions: `{ errors: [{ code }] }` / `{ Errors: [{ Code }] }` / a bare `{ code }` / `{ error }`.
 *  Returns `[]` when there is no error node (a successful/ready response). Pure. */
export function extractPriorErrorCodes(response: unknown): string[] {
  if (!response || typeof response !== 'object') return []
  const obj = response as Record<string, unknown>
  const list = obj.errors ?? obj.Errors
  if (Array.isArray(list)) {
    return list
      .map((e) => {
        const row = (e && typeof e === 'object' ? e as Record<string, unknown> : {})
        const code = row.code ?? row.Code ?? row.errorCode
        return code == null ? '' : String(code)
      })
      .filter(Boolean)
  }
  const single = obj.code ?? obj.Code ?? obj.error
  return single ? [String(single)] : []
}

/** Whether a poll body looks like a READY resource envelope — i.e. it actually carries the `data`
 *  node the normalizer reads. Used to keep an UNRECOGNIZED body (a throttle/gateway/HTML page with
 *  no error codes) from being mistaken for "ready with zero transactions". Pure. */
export function hasPriorDataEnvelope(response: unknown): boolean {
  return Boolean(response && typeof response === 'object' && typeof (response as Record<string, unknown>).data === 'object' && (response as Record<string, unknown>).data !== null)
}

/**
 * Classify a poll response body: `pending` (resource not yet generated → poll again), `ready` (a
 * recognizable `data` envelope with no error codes → normalize it), or `error` with the offending
 * codes / a marker for an unrecognized body.
 *
 * FAIL-CLOSED on an unrecognized body: a throttle (429), a gateway page or any non-envelope reply
 * carries no error codes, and treating that as `ready` would normalize to ZERO transactions —
 * silently reporting "no operations" for a window that actually had some (statement data loss,
 * the exact failure `alfaStatementErrors` guards against on the Alfa side). Pure — the caller owns
 * the HTTP status, the wait/retry loop and the transport.
 */
export function classifyPriorPoll(response: unknown): { status: 'pending' | 'ready' } | { status: 'error', codes: string[] } {
  const codes = extractPriorErrorCodes(response)
  if (codes.includes(PRIOR_RESOURCE_NOT_CREATED)) return { status: 'pending' }
  if (codes.length > 0) return { status: 'error', codes }
  if (!hasPriorDataEnvelope(response)) return { status: 'error', codes: ['unrecognized-response'] }
  return { status: 'ready' }
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
