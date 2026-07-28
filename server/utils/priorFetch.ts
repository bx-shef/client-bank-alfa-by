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
// GATING: this engine is reachable only for an account with a STORED Prior token. Prior is not
// yet in the poll planner's POLLABLE_PROVIDERS nor wired into the connect flow (slices 2-3), so
// in the current runtime nothing routes here — it is code-complete but inert, and prod needs the
// BY-crypto TLS СКЗИ gateway (docs/PRIOR_API.md, issue #41). Verified by unit tests against a
// mocked transport; a live sandbox run needs the owner's Prior creds.

import type { StatementItem } from '../../app/types/statement'
import {
  buildPriorResourceCreatePath,
  buildPriorResourcePollPath,
  buildResourceRequestBody,
  classifyPriorPoll,
  extractResourceId,
  isWindowWithinLimit,
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

/** Injected side-effects, so the engine is unit-testable without network/timers. */
export interface PriorFetchDeps {
  ensureFresh: (token: BankToken) => Promise<BankToken>
  /** OB API base origin (`PRIOR_OAUTH_API_BASE`, no trailing slash), or `null` when unset. */
  apiBase: () => string | null
  /** POST a JSON body with a Bearer token; returns the parsed JSON. Must NOT leak the auth on error. */
  postJson: (url: string, accessToken: string, body: unknown) => Promise<unknown>
  /** GET a resource with a Bearer token; returns the parsed JSON body INCLUDING a pending/error
   *  envelope (must not throw on the BY.NBRB.Resource.NotCreated poll response — the engine
   *  classifies it). Throws only on network / non-JSON / hard transport failures. */
  pollJson: (url: string, accessToken: string) => Promise<unknown>
  sleep: (ms: number) => Promise<void>
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
  pollJson: async (url, accessToken) => {
    const fetchJson = $fetch as unknown as (
      url: string,
      opts: { method: string, headers: Record<string, string>, timeout: number, ignoreResponseError: boolean }
    ) => Promise<unknown>
    // ignoreResponseError: keep the JSON body of a 4xx (the NotCreated pending envelope) instead of
    // throwing — the engine classifies pending-vs-hard-error from the body's error codes.
    return fetchJson(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      timeout: 20_000,
      ignoreResponseError: true
    })
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

  // 1) CREATE the async transaction list.
  const createUrl = `${base}${buildPriorResourceCreatePath(RESOURCE_KIND, query.account)}`
  const created = await deps.postJson(createUrl, token.accessToken, buildResourceRequestBody(RESOURCE_KIND, from, to))
  const resourceId = extractResourceId(RESOURCE_KIND, created)
  if (!resourceId) {
    throw new Error(`fetchPriorStatement: create returned no ${RESOURCE_KIND} id for account ${query.account}`)
  }

  // 2) POLL until ready (bounded).
  const pollUrl = `${base}${buildPriorResourcePollPath(RESOURCE_KIND, query.account, resourceId)}`
  for (let attempt = 0; attempt < PRIOR_POLL_MAX_ATTEMPTS; attempt++) {
    const body = await deps.pollJson(pollUrl, token.accessToken)
    const verdict = classifyPriorPoll(body)
    if (verdict.status === 'ready') {
      // 3) NORMALIZE (ctx.account = the account we queried; currency falls back per-tx).
      return normalizePriorTransactionList(body as PriorTransactionListResponse, { account: query.account })
    }
    if (verdict.status === 'error') {
      throw new Error(`fetchPriorStatement: poll error for account ${query.account} — ${verdict.codes.join('; ')}`)
    }
    // pending → wait and retry (skip the wait after the final attempt).
    if (attempt < PRIOR_POLL_MAX_ATTEMPTS - 1) await deps.sleep(PRIOR_POLL_DELAY_MS)
  }
  throw new Error(`fetchPriorStatement: ${RESOURCE_KIND} not ready after ${PRIOR_POLL_MAX_ATTEMPTS} polls for account ${query.account}`)
}
