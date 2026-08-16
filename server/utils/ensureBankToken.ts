// Ensure a connected bank account has a valid access token before an online-fetch REST
// call: refresh via the bank's OAuth when near expiry and persist the rotated tokens.
// Mirrors `ensureAccessToken.ts` (the B24 portal refresh) — same per-portal advisory-lock
// + re-read-inside-the-lock discipline, so when N poll workers hit the same near-expiry
// account exactly ONE refreshes (banks rotate the refresh token, so a race would
// permanently break the stored credential).
//
// Provider-specific bits (refresh body/headers, response parse) come from the tested pure
// cores (`alfaOauth`/`priorOauth`). The live refresh wiring ships HERE (A4): `bankCredsFromEnv`
// reads `ALFA_OAUTH_*`/`PRIOR_OAUTH_*` and `liveDeps.postRefresh` does the real `$fetch` POST.
// Without creds for a provider this returns the stored token as-is (like `ensureAccessToken`
// without B24_CLIENT_ID/SECRET). A5 owns a DIFFERENT leg — the statement fetch+normalize
// (`token → $fetch → normalizeAlfa/normalizePrior`), not this token refresh.

import { randomUUID } from 'node:crypto'
import { buildRefreshBody, parseTokenResponse } from '../../app/utils/alfaOauth'
import { buildPriorRefreshBody, parsePriorTokenResponse, priorTokenRequest } from '../../app/utils/priorOauth'
import type { PriorTokenAuth } from '../../app/utils/priorOauth'
import { priorAuthMethodFromEnv, resolvePriorTokenAuth } from './priorTokenAuth'
import { signPriorJwt } from './priorJwt'
import { normalizeBankApiBase } from '../../app/utils/bankGatewayUrl'
import type { BankProviderId } from '../../app/types/statement'
import { withAdvisoryLock } from './dbLock'
import { bankRefreshLockKey } from './bankRefreshLock'
import { getBankToken, updateBankTokenSecrets } from './bankTokenStore'
import type { BankToken } from './bankTokenStore'
import type { QueryFn } from './tokenStore'

/** True when the bank access token is within `skewMs` of expiry (pure, testable). */
export function needsBankRefresh(token: BankToken, nowMs: number, skewMs = 60_000): boolean {
  return token.expiresAt <= nowMs + skewMs
}

/** A provider's OAuth client creds + token endpoint (from env, per bank). */
export interface BankOAuthCreds {
  clientId: string
  clientSecret: string
  /** Absolute `POST` token URL (`https://<host>[:port]/token`). */
  tokenUrl: string
}

/** Normalized result of a token refresh (both providers reduce to this). */
export interface BankRefreshResult {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

/**
 * Build the provider-specific refresh request (pure): the token URL, the form body, and any
 * request headers. The two banks authenticate the token endpoint DIFFERENTLY:
 *  - Alfa carries `client_id`+`client_secret` IN THE BODY (no auth header).
 *  - Prior authenticates per its DCR-registered `token_endpoint_auth_method` — `client_secret_basic`
 *    (Authorization header) in sandbox, `private_key_jwt` (signed `client_assertion` in the body)
 *    in production (#444). `priorAuth` carries whichever the caller resolved; absent ⇒ Basic from
 *    `creds`, preserving the previous behaviour. Sending neither → 401.
 */
export function bankRefreshRequest(
  provider: BankProviderId,
  creds: BankOAuthCreds,
  refreshToken: string,
  priorAuth?: PriorTokenAuth
): { url: string, body: string, headers: Record<string, string> } {
  if (provider === 'alfa-by') {
    return { url: creds.tokenUrl, body: buildRefreshBody({ clientId: creds.clientId }, refreshToken, creds.clientSecret).toString(), headers: {} }
  }
  if (provider === 'prior-by') {
    const auth: PriorTokenAuth = priorAuth
      ?? { method: 'client_secret_basic', clientId: creds.clientId, clientSecret: creds.clientSecret }
    const req = priorTokenRequest(buildPriorRefreshBody(refreshToken), auth)
    return { url: creds.tokenUrl, body: req.body, headers: req.headers }
  }
  throw new Error(`bankRefreshRequest: provider ${provider} has no online-fetch OAuth (manual import only)`)
}

/** Parse a provider's `/token` JSON into the normalized refresh result (pure). Throws on
 *  an OAuth error payload or a missing access token (via the tested provider parsers). */
export function parseBankRefresh(provider: BankProviderId, raw: unknown): BankRefreshResult {
  if (provider === 'alfa-by') {
    const t = parseTokenResponse(raw as never)
    return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresIn: t.expiresIn }
  }
  if (provider === 'prior-by') {
    const t = parsePriorTokenResponse(raw as never)
    // Prior may omit refresh_token on refresh — keep the old one (caller falls back too).
    return { accessToken: t.accessToken, refreshToken: t.refreshToken ?? '', expiresIn: t.expiresIn }
  }
  throw new Error(`parseBankRefresh: provider ${provider} has no online-fetch OAuth`)
}

/** Injected side-effects, so the refresh logic is unit-testable without DB/network. */
export interface BankRefreshDeps {
  now: () => number
  withLock: <T>(key: string, fn: (q: QueryFn) => Promise<T>) => Promise<T>
  loadToken: (q: QueryFn, memberId: string, provider: BankProviderId, accountKey: string) => Promise<BankToken | null>
  /** Persist the refreshed tokens. **UPDATE-only** — `false` means the row is already gone and
   *  must NOT be recreated: the account was disconnected while we were at the bank (#505). */
  saveToken: (q: QueryFn, token: BankToken) => Promise<boolean>
  /** Per-provider OAuth creds (from env), or `null` when the bank isn't configured. */
  creds: (provider: BankProviderId) => BankOAuthCreds | null
  /** POST the refresh body to the token URL (with provider-specific auth headers) and
   *  return the raw JSON. */
  postRefresh: (url: string, body: string, headers: Record<string, string>) => Promise<unknown>
  /** Resolve Prior's client authentication (signs a fresh `client_assertion` under
   *  private_key_jwt, #444). `null`/absent ⇒ fall back to client_secret_basic from `creds` —
   *  the sandbox behaviour. Injected so the refresh stays testable without node:crypto. */
  priorTokenAuth?: () => PriorTokenAuth | null
}

/** Resolve a provider's OAuth creds from env. Alfa: `ALFA_OAUTH_*`; Prior: `PRIOR_OAUTH_*`.
 *  Returns `null` when a required part is unset — the account then can't be refreshed here.
 *
 *  `clientSecret` is required only for `client_secret_basic`: under `private_key_jwt` the secret
 *  never travels (the assertion authenticates us), and the bank may not even issue one for such a
 *  client — demanding it would disable refresh on an otherwise correct production config (#444). */
export function bankCredsFromEnv(provider: BankProviderId): BankOAuthCreds | null {
  const prefix = provider === 'alfa-by' ? 'ALFA_OAUTH' : provider === 'prior-by' ? 'PRIOR_OAUTH' : ''
  if (!prefix) return null
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim()
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim()
  // The token URL carries the refresh token — and, under client_secret_basic, the client secret
  // itself. Validate the scheme like every other bank address (#455): `http://` only towards an
  // internal gateway. A full URL (not just an origin) is fine — the rules look at scheme + host.
  const tokenUrl = normalizeBankApiBase(process.env[`${prefix}_TOKEN_URL`])
  const secretOptional = provider === 'prior-by' && priorAuthMethodFromEnv() === 'private_key_jwt'
  if (!clientId || !tokenUrl || (!clientSecret && !secretOptional)) return null
  return { clientId, clientSecret: clientSecret ?? '', tokenUrl }
}

/**
 * Prior's client auth from env for the refresh leg (#444).
 *
 * ⚠ Fail-loud on a BROKEN `private_key_jwt` config, `null` only when Prior simply isn't configured.
 * The distinction matters: `resolvePriorTokenAuth` deliberately throws instead of degrading, and
 * swallowing that here would re-introduce exactly what it forbids — the caller treats `null` as
 * «no auth supplied» and falls back to `client_secret_basic`, i.e. sends the real client secret to
 * a token endpoint whose client is registered for private_key_jwt only. The bank answers with an
 * opaque 401 that reads like an ordinary refresh failure, so the misconfiguration hides.
 *
 * The refresh runs on the worker/cron process, separately from the connect routes, so a PEM missing
 * on just that instance is a realistic deploy slip. Throwing fails the single `bank-fetch` job for
 * that account (BullMQ isolates it) with the cause stated at the point of failure.
 */
export function priorRefreshAuthFromEnv(): PriorTokenAuth | null {
  const method = priorAuthMethodFromEnv()
  const clientId = process.env.PRIOR_OAUTH_CLIENT_ID?.trim()
  const clientSecret = process.env.PRIOR_OAUTH_CLIENT_SECRET?.trim()
  // Not configured at all ⇒ nothing to authenticate with; the caller degrades as before.
  // Under private_key_jwt the secret is irrelevant, so only the id gates this branch.
  if (!clientId || (!clientSecret && method === 'client_secret_basic')) return null
  // Throws when private_key_jwt lacks key/kid/audience — intentionally NOT caught (see above).
  return resolvePriorTokenAuth(method, {
    clientId,
    clientSecret: clientSecret ?? '',
    audience: process.env.PRIOR_OAUTH_AUDIENCE?.trim() ?? '',
    privateKeyPem: process.env.PRIOR_OAUTH_PRIVATE_KEY?.trim() ?? '',
    kid: process.env.PRIOR_OAUTH_KID?.trim() ?? ''
  }, {
    signJwt: signPriorJwt,
    nowSec: () => Math.floor(Date.now() / 1000),
    newId: () => randomUUID()
  })
}

const liveDeps: BankRefreshDeps = {
  now: Date.now,
  withLock: withAdvisoryLock,
  loadToken: getBankToken,
  // UPDATE-only: a refresh may not create a connection — only the OAuth callback may (#505).
  saveToken: updateBankTokenSecrets,
  creds: bankCredsFromEnv,
  priorTokenAuth: priorRefreshAuthFromEnv,
  postRefresh: (url, body, headers) => {
    // Cast $fetch to a plain signature (dynamic URL → opt out of Nitro route-type
    // inference; same guard as ensureAccessToken/callRest). Bounded so a hung OAuth call
    // can't hold the advisory lock + pooled connection indefinitely.
    const fetchJson = $fetch as unknown as (
      url: string,
      opts: { method: string, body: string, headers: Record<string, string>, timeout: number }
    ) => Promise<unknown>
    return fetchJson(url, {
      method: 'POST',
      body,
      // Provider auth header (Prior: Basic; Alfa: none) merged over the form content-type.
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      timeout: 15_000
    })
  }
}

/**
 * Return a valid access token for the connected bank account, refreshing (once, under a
 * per-account lock) if within the skew of expiry, and persisting the rotated tokens.
 * Without provider creds it hands back the stored token (may be expired) so the caller's
 * fetch fails cleanly rather than corrupting anything. `opts.force` refreshes even when the
 * token looks clock-fresh (reactive retry after the bank rejected it early) — same lock,
 * and inside the lock it only refreshes when the stored access token is STILL the rejected
 * one (a concurrent worker may have rotated it already).
 */
export async function ensureBankToken(
  token: BankToken,
  deps: BankRefreshDeps = liveDeps,
  opts: { force?: boolean } = {}
): Promise<BankToken> {
  if (!opts.force && !needsBankRefresh(token, deps.now())) return token

  const creds = deps.creds(token.provider)
  if (!creds) {
    console.warn(`[ensureBankToken] ${token.provider} near/at expiry but OAuth creds unset — cannot refresh`)
    return token
  }

  // ⚠ The key comes from the SHARED helper, not assembled here as a string. Account selection now
  // takes the same lock (`renameBankTokenAccount`, #509): it changes `account_key` — the very field
  // we use to find our row. A differently-spelled key would mean the lock is "held" while the two
  // sides never actually meet — silently, with no error at all.
  return deps.withLock(bankRefreshLockKey(token.memberId, token.provider, token.accountKey), async (q) => {
    // Re-read INSIDE the lock — another worker may have refreshed (or the account been
    // disconnected) while we waited. No stored row → don't refresh+save (would resurrect a
    // disconnected account); hand back the passed token, the fetch will fail cleanly.
    const stored = await deps.loadToken(q, token.memberId, token.provider, token.accountKey)
    if (!stored) return token
    const shouldRefresh = opts.force ? stored.accessToken === token.accessToken : needsBankRefresh(stored, deps.now())
    if (!shouldRefresh) return stored

    // No refresh token to spend (Prior may omit one — the callback stores it empty rather than
    // failing the connect). Posting `refresh_token=` would just earn a 400 on EVERY poll tick
    // forever; skip the doomed round-trip and log an ACTIONABLE line instead. The caller's fetch
    // then fails on the expired access token, which is the honest state: reconnect required.
    if (!stored.refreshToken) {
      console.warn(`[ensureBankToken] ${stored.provider} account has no refresh_token — RECONNECT REQUIRED (re-run the bank connect for this account)`)
      return stored
    }

    const priorAuth = stored.provider === 'prior-by' ? (deps.priorTokenAuth?.() ?? undefined) : undefined
    const { url, body, headers } = bankRefreshRequest(stored.provider, creds, stored.refreshToken, priorAuth)
    const r = parseBankRefresh(stored.provider, await deps.postRefresh(url, body, headers))
    const updated: BankToken = {
      ...stored,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken || stored.refreshToken,
      expiresAt: deps.now() + r.expiresIn * 1000
    }
    // ⚠ UPDATE-only, and the result IS checked. The row may have vanished WHILE we were at the
    // bank: the lock holds back other refreshers, but an advisory lock does not hold back a plain
    // `DELETE`, and the POST runs up to 15 s. This used to be an upsert, so a disconnected account
    // came back with a fresh token — the app kept reaching into the client's bank after they had
    // forbidden it (#505).
    if (!await deps.saveToken(q, updated)) {
      console.warn(`[ensureBankToken] ${stored.provider} account was disconnected mid-refresh — token NOT stored`)
      return stored
    }
    return updated
  })
}
