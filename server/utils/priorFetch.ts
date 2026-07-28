// Priorbank Open Banking (СПР) statement fetch engine (stage 5, A5b) — the async
// create-then-poll flow the synchronous Alfa GET (bankFetch.ts) does NOT cover:
//
//   POST <OB>/accounts/{accountId}/transactions           → transactionListId
//   GET  <OB>/accounts/{accountId}/transactions/{id}       → poll until ready
//        (while generating the poll returns BY.NBRB.Resource.NotCreated → wait+retry)
//   → normalizePrior(data.transaction[])                   → StatementItem[]
//
// Pure request/response bits (paths, poll classification, window cap) live in the tested
// core app/utils/priorOauth.ts; the transport (POST/GET/sleep) is injected here so the engine
// is unit-testable without network. Provider auth is the short-lived Bearer (token B) — the
// account's stored token is refreshed first (A4 ensureBankToken, Prior client_secret_basic).
//
// ACCOUNT IDENTITY: what we store (bank_tokens.account_key, typed by the admin at connect time) is
// the account NUMBER / IBAN, but Prior addresses an account by an OPAQUE bank-issued `accountId` in
// the URL path. `resolvePriorAccountId` bridges the two via `GET /accounts` before the create call —
// without it every request would target a nonexistent account.
//
// GATING: the engine is reachable only for an account with a STORED Prior token, and Prior is NOT
// yet in the poll planner's POLLABLE_PROVIDERS (see server/queue/cron.ts for the two poller-level
// gaps that must close first — per-request rate accounting and worker-slot occupancy). The connect
// flow IS wired, so accounts can be connected today; prod additionally needs the BY-crypto TLS СКЗИ
// gateway (docs/PRIOR_API.md, issue #41). Verified by unit tests against a mocked transport; a live
// sandbox run needs the owner's Prior creds.

import type { StatementItem } from '../../app/types/statement'
import {
  buildPriorResourceCreatePath,
  buildPriorResourcePollPath,
  buildResourceRequestBody,
  classifyPriorPoll,
  extractAccounts,
  extractResourceId,
  isWindowWithinLimit,
  PRIOR_API_PREFIXES,
  PRIOR_MAX_WINDOW_DAYS
} from '../../app/utils/priorOauth'
import { normalizePriorTransactionList, type PriorTransactionListResponse } from '../../app/utils/priorStatement'
import { ensureBankToken } from './ensureBankToken'
import type { BankToken } from './bankTokenStore'
import type { BankFetchQuery } from './bankFetch'

/** We fetch TRANSACTIONS (not statements): the response is `data.transaction[]`, exactly what
 *  `normalizePrior` consumes. Both endpoints share the create+poll shape (PriorResourceKind). */
const RESOURCE_KIND = 'transactions' as const

/** Poll budget for the async resource. Priorbank generates the list server-side; sandbox is slow
 *  AND hard-throttles (429) per account, so keep the cadence modest. Bounded so a never-ready
 *  resource fails the job (BullMQ retries) instead of hanging a worker. */
export const PRIOR_POLL_MAX_ATTEMPTS = 8
export const PRIOR_POLL_DELAY_MS = 1500

/** Extract the `YYYY-MM-DD` head of an ISO date (Prior wants a bare date). Throws on a value with
 *  no parseable date head — a bad window must fail loud, not fetch garbage (mirrors isoToAlfaDate). */
export function isoDateOnly(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso).trim())
  if (!m) throw new Error(`priorFetch.isoDateOnly: not an ISO date: ${iso}`)
  return m[1]!
}

/** A poll reply: the HTTP status AND the parsed body. The status matters on its own — a 429/5xx
 *  body carries no Prior error codes, so classifying by body alone would read it as "ready with
 *  zero transactions" (silent statement loss). */
export interface PriorPollReply {
  status: number
  body: unknown
}

/** Injected side-effects, so the engine is unit-testable without network/timers. */
export interface PriorFetchDeps {
  ensureFresh: (token: BankToken) => Promise<BankToken>
  /** OB API base origin (`PRIOR_OAUTH_API_BASE`, no trailing slash), or `null` when unset. */
  apiBase: () => string | null
  /** GET a JSON resource with a Bearer token (used for the accounts list). Throws on failure. */
  getJson: (url: string, accessToken: string) => Promise<unknown>
  /** POST a JSON body with a Bearer token; returns the parsed JSON. Must NOT leak the auth on error. */
  postJson: (url: string, accessToken: string, body: unknown) => Promise<unknown>
  /** GET a resource with a Bearer token; returns the HTTP status AND the parsed body, WITHOUT
   *  throwing on a 4xx (the BY.NBRB.Resource.NotCreated pending envelope arrives as one) — the
   *  engine classifies status+body itself. Throws only on network / non-JSON failures. */
  pollJson: (url: string, accessToken: string) => Promise<PriorPollReply>
  sleep: (ms: number) => Promise<void>
}

/** HTTP statuses that mean "not an answer yet, try again": the bank throttles hard (429) and the
 *  gateway can blip (5xx). Anything else non-2xx is a hard failure. */
export function isRetryablePollStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

/**
 * Resolve the bank-issued Open Banking `accountId` for the stored account key. Prior addresses an
 * account by an OPAQUE id in the URL path (`/accounts/{accountId}/…`), but what we store (and what
 * the admin typed at connect time) is the account NUMBER / IBAN — so the two must be bridged via
 * `GET /accounts`, matching on `identification` (the IBAN) or on the id itself (if the admin
 * already entered the accountId). Case-insensitive; throws when the account isn't in the consent's
 * account list (a wrong/unauthorized account must fail loud, not fetch someone else's).
 */
export async function resolvePriorAccountId(
  base: string,
  accountKey: string,
  accessToken: string,
  deps: Pick<PriorFetchDeps, 'getJson'>
): Promise<string> {
  const raw = await deps.getJson(`${base}${PRIOR_API_PREFIXES.OB}/accounts`, accessToken)
  const wanted = accountKey.trim().toUpperCase()
  const match = extractAccounts(raw).find(
    a => a.accountId.toUpperCase() === wanted || (a.identification ?? '').toUpperCase() === wanted
  )
  if (!match) throw new Error(`resolvePriorAccountId: account ${accountKey} not found in the consent's account list`)
  return match.accountId
}

/** Read the OB base from env (`PRIOR_OAUTH_API_BASE`), stripped of trailing slashes; `null` when unset. */
export function priorApiBaseFromEnv(): string | null {
  const base = process.env.PRIOR_OAUTH_API_BASE?.trim()
  return base ? base.replace(/\/+$/, '') : null
}

const liveDeps: PriorFetchDeps = {
  ensureFresh: token => ensureBankToken(token),
  apiBase: priorApiBaseFromEnv,
  postJson: async (url, accessToken, body) => {
    const fetchJson = $fetch as unknown as (
      url: string,
      opts: { method: string, body: unknown, headers: Record<string, string>, timeout: number }
    ) => Promise<unknown>
    return fetchJson(url, {
      method: 'POST',
      body,
      headers: { 'authorization': `Bearer ${accessToken}`, 'content-type': 'application/json' },
      timeout: 20_000
    })
  },
  getJson: async (url, accessToken) => {
    const fetchJson = $fetch as unknown as (
      url: string,
      opts: { method: string, headers: Record<string, string>, timeout: number }
    ) => Promise<unknown>
    return fetchJson(url, { method: 'GET', headers: { authorization: `Bearer ${accessToken}` }, timeout: 20_000 })
  },
  pollJson: async (url, accessToken) => {
    // `.raw` keeps BOTH the status and the parsed body: ignoreResponseError alone would hand back a
    // 429/gateway body indistinguishable from a ready-but-empty statement (silent data loss).
    const fetchRaw = ($fetch as unknown as { raw: (
      url: string,
      opts: { method: string, headers: Record<string, string>, timeout: number, ignoreResponseError: boolean }
    ) => Promise<{ status: number, _data: unknown }> }).raw
    const res = await fetchRaw(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      timeout: 20_000,
      ignoreResponseError: true
    })
    return { status: res.status, body: res._data }
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Fetch + normalize one Priorbank statement window for a connected account (async create+poll).
 * `stored` is the account's token (already loaded by the caller); it is refreshed first. Returns
 * the operations as `StatementItem[]`. THROWS on: unconfigured API base, an over-cap window, a
 * missing created-resource id, a hard poll error, or exhausting the poll budget — so the job
 * retries rather than masquerading an error as "no operations".
 */
export async function fetchPriorStatement(
  query: BankFetchQuery,
  stored: BankToken,
  deps: PriorFetchDeps = liveDeps
): Promise<StatementItem[]> {
  const base = deps.apiBase()
  if (!base) throw new Error('fetchPriorStatement: PRIOR_OAUTH_API_BASE not configured')

  const from = isoDateOnly(query.dateFrom)
  const to = isoDateOnly(query.dateTo)
  if (!isWindowWithinLimit(from, to)) {
    throw new Error(`fetchPriorStatement: window ${from}..${to} exceeds Priorbank's ${PRIOR_MAX_WINDOW_DAYS}-day cap`)
  }

  const token = await deps.ensureFresh(stored)

  // 0) RESOLVE the bank's opaque accountId — what we store is the account NUMBER / IBAN, but the
  //    resource URL addresses the account by the id from `GET /accounts` (they are NOT the same).
  const accountId = await resolvePriorAccountId(base, query.account, token.accessToken, deps)

  // 1) CREATE the async transaction list.
  const createUrl = `${base}${buildPriorResourceCreatePath(RESOURCE_KIND, accountId)}`
  const created = await deps.postJson(createUrl, token.accessToken, buildResourceRequestBody(RESOURCE_KIND, from, to))
  const resourceId = extractResourceId(RESOURCE_KIND, created)
  if (!resourceId) {
    throw new Error(`fetchPriorStatement: create returned no ${RESOURCE_KIND} id for account ${query.account}`)
  }

  // 2) POLL until ready (bounded). A 429/5xx counts as "not an answer yet" — never as an empty
  //    statement — so a throttled window can't silently report "no operations".
  const pollUrl = `${base}${buildPriorResourcePollPath(RESOURCE_KIND, accountId, resourceId)}`
  for (let attempt = 0; attempt < PRIOR_POLL_MAX_ATTEMPTS; attempt++) {
    const { status, body } = await deps.pollJson(pollUrl, token.accessToken)
    if (!isRetryablePollStatus(status)) {
      const verdict = classifyPriorPoll(body)
      if (verdict.status === 'ready') {
        // 3) NORMALIZE (ctx.account = OUR stored account key — the statement belongs to it, not to
        //    the bank's internal id — so downstream dedup keys stay stable across id changes).
        return normalizePriorTransactionList(body as PriorTransactionListResponse, { account: query.account })
      }
      if (verdict.status === 'error') {
        throw new Error(`fetchPriorStatement: poll error for account ${query.account} (HTTP ${status}) — ${verdict.codes.join('; ')}`)
      }
    }
    // pending (or a throttled/blipped status) → wait and retry (skip the wait after the last attempt).
    if (attempt < PRIOR_POLL_MAX_ATTEMPTS - 1) await deps.sleep(PRIOR_POLL_DELAY_MS)
  }
  throw new Error(`fetchPriorStatement: ${RESOURCE_KIND} not ready after ${PRIOR_POLL_MAX_ATTEMPTS} polls for account ${query.account}`)
}
