// Ensure a connected bank account has a valid access token before an online-fetch REST
// call: refresh via the bank's OAuth when near expiry and persist the rotated tokens.
// Mirrors `ensureAccessToken.ts` (the B24 portal refresh) — same per-portal advisory-lock
// + re-read-inside-the-lock discipline, so when N poll workers hit the same near-expiry
// account exactly ONE refreshes (banks rotate the refresh token, so a race would
// permanently break the stored credential).
//
// Provider-specific bits (refresh body, response parse) come from the tested pure cores
// (`alfaOauth`/`priorOauth`). The HTTP POST + the per-provider client creds/token URL are
// injected (`BankRefreshDeps`) — the live wiring (env creds, base URLs) lands with the
// bank transport slice (A5). Without creds for a provider this returns the stored token
// as-is (like `ensureAccessToken` without B24_CLIENT_ID/SECRET).

import { buildRefreshBody, parseTokenResponse } from '../../app/utils/alfaOauth'
import { buildPriorRefreshBody, parsePriorTokenResponse } from '../../app/utils/priorOauth'
import type { BankProviderId } from '../../app/types/statement'
import { withAdvisoryLock } from './dbLock'
import { getBankToken, saveBankToken } from './bankTokenStore'
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
 * Build the provider-specific refresh request (pure): the token URL to POST and the form
 * body string. Alfa carries `client_id`+`client_secret` in the body; Prior's refresh body
 * is `grant_type`+`refresh_token` (client auth is via the registered DCR client / base).
 */
export function bankRefreshRequest(provider: BankProviderId, creds: BankOAuthCreds, refreshToken: string): { url: string, body: string } {
  if (provider === 'alfa-by') {
    return { url: creds.tokenUrl, body: buildRefreshBody({ clientId: creds.clientId }, refreshToken, creds.clientSecret).toString() }
  }
  if (provider === 'prior-by') {
    return { url: creds.tokenUrl, body: buildPriorRefreshBody(refreshToken).toString() }
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
  saveToken: (q: QueryFn, token: BankToken) => Promise<void>
  /** Per-provider OAuth creds (from env), or `null` when the bank isn't configured. */
  creds: (provider: BankProviderId) => BankOAuthCreds | null
  /** POST the refresh body to the token URL and return the raw JSON. */
  postRefresh: (url: string, body: string) => Promise<unknown>
}

/** Resolve a provider's OAuth creds from env. Alfa: `ALFA_OAUTH_*`; Prior: `PRIOR_OAUTH_*`.
 *  Returns `null` when any part is unset — the account then can't be refreshed here. */
export function bankCredsFromEnv(provider: BankProviderId): BankOAuthCreds | null {
  const prefix = provider === 'alfa-by' ? 'ALFA_OAUTH' : provider === 'prior-by' ? 'PRIOR_OAUTH' : ''
  if (!prefix) return null
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim()
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim()
  const tokenUrl = process.env[`${prefix}_TOKEN_URL`]?.trim()
  if (!clientId || !clientSecret || !tokenUrl) return null
  return { clientId, clientSecret, tokenUrl }
}

const liveDeps: BankRefreshDeps = {
  now: Date.now,
  withLock: withAdvisoryLock,
  loadToken: getBankToken,
  saveToken: saveBankToken,
  creds: bankCredsFromEnv,
  postRefresh: (url, body) => {
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
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
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

  return deps.withLock(`bankrefresh:${token.memberId}:${token.provider}:${token.accountKey}`, async (q) => {
    // Re-read INSIDE the lock — another worker may have refreshed (or the account been
    // disconnected) while we waited. No stored row → don't refresh+save (would resurrect a
    // disconnected account); hand back the passed token, the fetch will fail cleanly.
    const stored = await deps.loadToken(q, token.memberId, token.provider, token.accountKey)
    if (!stored) return token
    const shouldRefresh = opts.force ? stored.accessToken === token.accessToken : needsBankRefresh(stored, deps.now())
    if (!shouldRefresh) return stored

    const { url, body } = bankRefreshRequest(stored.provider, creds, stored.refreshToken)
    const r = parseBankRefresh(stored.provider, await deps.postRefresh(url, body))
    const updated: BankToken = {
      ...stored,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken || stored.refreshToken,
      expiresAt: deps.now() + r.expiresIn * 1000
    }
    await deps.saveToken(q, updated)
    return updated
  })
}
