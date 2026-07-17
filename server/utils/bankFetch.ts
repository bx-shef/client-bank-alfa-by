// Bank online-fetch transport (stage 5, A5): fetch a statement window from a bank's API
// and normalize it to StatementItem[] — the live replacement for the worker's
// `fetchStatement` stub. Ensures the account's access token is fresh (A4 ensureBankToken)
// before the call. Provider-specific request shape / auth live here; the raw→StatementItem[]
// map reuses the tested pure normalizer `normalizeAlfa` (Prior's `normalizePrior` joins at A5b).
//
// Alfa first (roadmap): a synchronous `GET /accounts/statement`. Prior's async create+poll
// (`POST`/`GET /accounts/{id}/statements`) is A5b — surfaced as an explicit unsupported here,
// NOT a silent empty, so it can't masquerade as "no operations".
//
// A9 wiring note (not this commit): the worker's `fetchStatement(job: FetchJob)` dep is NOT a
// one-line `= fetchBankStatement`. A9 must (a) map the job to a BankFetchQuery — the queue
// layer names the field `providerId`, this transport (on the token layer) names it `provider`;
// (b) KEEP the `isDemoAccount(job.account)` branch (demoPause+demoItems) — a demo account has
// no stored token, so routing it here would return [] and silently kill the load demo; and
// (c) ensure the poll planner keys `bank_tokens.account_key` with the SAME value it puts in
// `FetchJob.account` (that value is also the Alfa `number=` param), or loadToken misses → [].
//
// The GET carries only a short-lived Bearer (no client_secret — that lives in the A4 refresh
// body). On failure we surface a clean top-level message (`status message`) so a plain
// `err.message` log is readable, while `{ cause }` preserves the chain — the same posture as
// b24Rest.ts, which already rethrows the raw ofetch error of an auth-bearing portal call.

import type { StatementItem, BankProviderId } from '../../app/types/statement'
import { normalizeAlfa, alfaStatementErrors, type AlfaStatementResponse } from '../../app/utils/alfaStatement'
import { ensureBankToken } from './ensureBankToken'
import { getBankToken } from './bankTokenStore'
import type { BankToken } from './bankTokenStore'
import { dbQuery } from '../db/client'

/** The statement window to fetch, resolved from a FetchJob. */
export interface BankFetchQuery {
  memberId: string
  provider: BankProviderId
  account: string
  /** ISO dates (inclusive). Converted to the provider's own format in the request. */
  dateFrom: string
  dateTo: string
}

/** Convert an ISO date (`YYYY-MM-DD` or full ISO) to Alfa's `DD.MM.YYYY`. Pure. Throws on a
 *  value with no parseable `YYYY-MM-DD` head (a bad window must fail loud, not fetch garbage). */
export function isoToAlfaDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso).trim())
  if (!m) throw new Error(`isoToAlfaDate: not an ISO date: ${iso}`)
  return `${m[3]}.${m[2]}.${m[1]}`
}

/** Build the Alfa `/accounts/statement` query (pure): account number + DD.MM.YYYY window +
 *  all-transactions, single page. Mirrors scripts/alfa-oauth-test.mjs. */
export function alfaStatementQuery(account: string, dateFrom: string, dateTo: string): URLSearchParams {
  return new URLSearchParams({
    number: account,
    dateFrom: isoToAlfaDate(dateFrom),
    dateTo: isoToAlfaDate(dateTo),
    transactions: '0', // all (credit+debit)
    pageNo: '0',
    pageRowCount: '0' // 0 = no paging cap
  })
}

/** Per-provider statement API base + path from env (`<PREFIX>_OAUTH_API_BASE`; Alfa path is
 *  the partner API prefix). Returns `null` when the base isn't configured (feature off). */
export function bankApiConfig(provider: BankProviderId): { base: string, statementPath: string } | null {
  // Strip ALL trailing slashes from the base and force a single leading slash on the path,
  // so a `…:8273/` base or a `partner/1.2.0` (no leading slash) env value still joins cleanly.
  const cleanBase = (s: string) => s.replace(/\/+$/, '')
  const asPath = (s: string) => `/${s.replace(/^\/+/, '').replace(/\/+$/, '')}`
  if (provider === 'alfa-by') {
    const base = process.env.ALFA_OAUTH_API_BASE?.trim()
    if (!base) return null
    const prefix = asPath(process.env.ALFA_OAUTH_API_PREFIX?.trim() || '/partner/1.2.0')
    return { base: cleanBase(base), statementPath: `${prefix}/accounts/statement` }
  }
  if (provider === 'prior-by') {
    const base = process.env.PRIOR_OAUTH_API_BASE?.trim()
    return base ? { base: cleanBase(base), statementPath: '/accounts' } : null
  }
  return null
}

/** Build the transport error from a caught fetch failure (exported for testing). Keeps a
 *  readable top-level `message` for a plain `err.message` log while `{ cause }` preserves the
 *  chain — the offending Bearer lives only in the (deep) cause, same posture as b24Rest.ts. */
export function bankFetchError(e: unknown): Error {
  const status = (e as { status?: number })?.status
  const message = (e as Error)?.message ?? 'error'
  return new Error(`bankFetch GET failed:${status ? ` ${status}` : ''} ${message}`, { cause: e })
}

/** Injected side-effects — so the transport is unit-testable without network/DB. */
export interface BankFetchDeps {
  loadToken: (memberId: string, provider: BankProviderId, account: string) => Promise<BankToken | null>
  ensureFresh: (token: BankToken) => Promise<BankToken>
  apiConfig: (provider: BankProviderId) => { base: string, statementPath: string } | null
  /** GET a JSON resource with a Bearer token. Implementations must NOT leak the auth on error. */
  getJson: (url: string, accessToken: string) => Promise<unknown>
}

const liveDeps: BankFetchDeps = {
  loadToken: (memberId, provider, account) => getBankToken(dbQuery, memberId, provider, account),
  ensureFresh: token => ensureBankToken(token),
  apiConfig: bankApiConfig,
  getJson: async (url, accessToken) => {
    const fetchJson = $fetch as unknown as (
      url: string,
      opts: { method: string, headers: Record<string, string>, timeout: number }
    ) => Promise<unknown>
    try {
      return await fetchJson(url, { method: 'GET', headers: { authorization: `Bearer ${accessToken}` }, timeout: 20_000 })
    } catch (e) {
      // Clean top-level message (readable `err.message` log); `cause` preserves the chain.
      throw bankFetchError(e)
    }
  }
}

/**
 * Fetch + normalize a statement window for one connected bank account. Returns the operations
 * as `StatementItem[]`. Returns `[]` (inert) when the account has no stored token — the poll
 * planner shouldn't schedule such accounts, but a race mustn't throw. On a per-account API
 * error (Alfa `errors[]` non-empty) it THROWS so the job retries (an errored empty `page` is
 * NOT "no operations", per alfaStatement.ts). Prior online fetch is not wired yet (A5b) → throws.
 */
export async function fetchBankStatement(query: BankFetchQuery, deps: BankFetchDeps = liveDeps): Promise<StatementItem[]> {
  const stored = await deps.loadToken(query.memberId, query.provider, query.account)
  if (!stored) return [] // not connected → nothing to fetch (inert, no throw)

  const cfg = deps.apiConfig(query.provider)
  if (!cfg) throw new Error(`fetchBankStatement: ${query.provider} API base not configured (set <PREFIX>_OAUTH_API_BASE)`)

  if (query.provider === 'alfa-by') {
    const token = await deps.ensureFresh(stored)
    const url = `${cfg.base}${cfg.statementPath}?${alfaStatementQuery(query.account, query.dateFrom, query.dateTo).toString()}`
    const raw = await deps.getJson(url, token.accessToken) as AlfaStatementResponse
    const errs = alfaStatementErrors(raw)
    if (errs.length > 0) {
      throw new Error(`fetchBankStatement alfa: account ${query.account} returned errors — ${errs.map(e => e.message ?? '?').join('; ')}`)
    }
    return normalizeAlfa(raw, { account: query.account })
  }

  // prior-by: async consent/create+poll flow — A5b follow-up. Fail loud (not a silent []).
  throw new Error(`fetchBankStatement: ${query.provider} online fetch not wired yet (A5b — Prior async create+poll)`)
}
