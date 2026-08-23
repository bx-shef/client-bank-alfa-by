// Bank online-fetch transport (stage 5, A5): fetch a statement window from a bank's API
// and normalize it to StatementItem[] — the live replacement for the worker's
// `fetchStatement` stub. Ensures the account's access token is fresh (A4 ensureBankToken)
// before the call. Provider-specific request shape / auth live here; the raw→StatementItem[]
// map reuses the tested pure normalizers (`normalizeAlfa` / `normalizePrior`).
//
// Alfa: a synchronous `GET /accounts/statement`. Prior (A5b): an async create+poll flow
// (`POST`/`GET /accounts/{id}/transactions`) — delegated to `fetchPriorStatement` (priorFetch.ts),
// which owns its own POST/poll transport. A provider with no online path fails loud (explicit
// throw, NOT a silent empty, so it can't masquerade as "no operations").
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

import type { WalkNotice } from './priorFetch'
import type { StatementItem, BankProviderId } from '../../app/types/statement'
import { normalizeAlfa, alfaStatementErrors, type AlfaStatementResponse } from '../../app/utils/alfaStatement'
import { ensureBankToken } from './ensureBankToken'
import { getBankToken } from './bankTokenStore'
import type { BankToken } from './bankTokenStore'
import { fetchPriorStatement } from './priorFetch'
import { dbQuery } from '../db/client'
import { normalizeBankApiBase } from '../../app/utils/bankGatewayUrl'
import { dedupKey } from '../../app/utils/statement'
import { useServerLogger } from './serverLogger'
import { logSafe } from './logSafe'

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
export function alfaStatementQuery(account: string, dateFrom: string, dateTo: string, pageNo: number = 0): URLSearchParams {
  return new URLSearchParams({
    number: account,
    dateFrom: isoToAlfaDate(dateFrom),
    dateTo: isoToAlfaDate(dateTo),
    transactions: '0', // all (credit+debit)
    pageNo: String(pageNo),
    // ⚠ Still `0`, and the docs still call that «все». We do NOT change it: the current request is
    // what production has been answering to, and a request nobody can re-verify against the bank is
    // not the place to experiment. `pageNo` is what we walk instead — see `fetchAlfaStatementPages`.
    pageRowCount: '0'
  })
}

const log = useServerLogger('fetch')

/**
 * Runaway backstop for page walking — not an expected limit.
 *
 * ⚠ It is NOT decoration and it is NOT redundant with {@link ALFA_WALK_BUDGET_MS}: which of the two
 * binds depends on the bank. A bank that answers instantly is bounded by this count (19 gaps ×
 * {@link ALFA_PAGE_DELAY_MS} stays well inside the time budget); a slow one is bounded by the time
 * budget long before page 20. Two independent limits, both reachable, both LOUD — see `AlfaWalkStop`.
 */
export const MAX_ALFA_STATEMENT_PAGES = 20

/** Courtesy gap between page requests of ONE account. Paid only when a page had rows, so a quiet
 *  day (page 0 empty) still costs one request and zero waiting. */
export const ALFA_PAGE_DELAY_MS = 500

/** Wall-clock ceiling on the whole walk, measured across the bank's own latency, not just our
 *  sleeps: 20 pages × a 20 s response is 400 s, and a job that long holds a worker slot for the
 *  better part of two cron ticks. Binding for a slow bank (see MAX_ALFA_STATEMENT_PAGES). */
export const ALFA_WALK_BUDGET_MS = 20_000

/**
 * Why a page walk stopped.
 *
 * ⚠ The split is the whole point of classifying at all: `exhausted`/`repeat` mean «the bank has no
 * more for this window», `page-cap`/`time-cap` mean «WE stopped, there may be more». Collapsing
 * them would rebuild the exact silent truncation #561 exists to end, one layer up.
 */
export type AlfaWalkStop = 'exhausted' | 'repeat' | 'page-cap' | 'time-cap'

export interface AlfaWalkResult {
  /** Pages actually requested (≥1). */
  pages: number
  /** Operations that came from pages 2..N — i.e. rows the single-request version was losing. */
  recovered: number
  stop: AlfaWalkStop
}

export interface AlfaWalkDeps {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * What to say in the log about a finished walk — `null` when there is nothing worth saying.
 *
 * Pure, and separate from the loop on purpose: «when do we log» is the part that silently rots, and
 * a decision embedded in a callback inside a transport can be mutated dead without a single test
 * turning red (the same reason `buildOpLogLine` exists). Two independent facts, so up to two
 * clauses: we recovered rows that used to vanish, and/or we stopped before the data ran out.
 *
 * ⚠ No `[fetch]` prefix: `ServerLineFormatter` already prints the channel, and a literal tag here
 * would render as `[fetch] WARNING: [fetch] …` — the exact duplication `buildOpLogLine` documents.
 */
export function alfaWalkNotice(label: string, info: AlfaWalkResult): WalkNotice | null {
  const truncated = info.stop === 'page-cap' || info.stop === 'time-cap'
  if (info.recovered <= 0 && !truncated) return null
  const parts: string[] = []
  if (info.recovered > 0) {
    parts.push(
      `страниц: ${info.pages}, со 2-й и дальше добрано операций: ${info.recovered}`
    )
  }
  if (truncated) {
    const why = info.stop === 'page-cap'
      ? `потолок ${MAX_ALFA_STATEMENT_PAGES} страниц`
      : `бюджет ${Math.round(ALFA_WALK_BUDGET_MS / 1000)} с`
    parts.push(
      `ОБХОД СТРАНИЦ ОБОРВАН на ${info.pages}-й (${why}) — выписка за это окно могла прийти НЕ ПОЛНОСТЬЮ;`
      + ' поднимите потолок или сузьте CRON_LOOKBACK_DAYS (#561)'
    )
  }
  // ⚠ Уровень разный по той же причине, что у близнеца в `priorFetch.ts`: штатно собранные
  // страницы — факт, а не тревога. Тревога — только обрыв обхода.
  return { level: truncated ? 'warn' : 'info', text: `${label}: ${parts.join(' | ')}` }
}

/**
 * Walk `GET /accounts/statement` pages until the bank runs out.
 *
 * ⚠ WHY THIS EXISTS (#561). We asked for one day and got back EXACTLY 100 operations, on five
 * separate days, with true zeros on the two days between — measured on the portal, not inferred.
 * There is no cap of 100 anywhere on our side (checked the whole bank→parse→crm-sync path), so the
 * number comes from the bank. `pageRowCount: '0'` is documented as «все», but that is a line in a
 * PDF, not a measurement — and we never read a page marker back, so if `0` actually means «default
 * page», we have been dropping everything past the first hundred every single day and could not
 * have known.
 *
 * ⚠ THE LOOP IS SAFE UNDER BOTH READINGS, which is the point — it does not require us to know which
 * is true:
 *   - `0` really means «все» ⇒ page 1 repeats page 0 (or is empty). We stop after ONE extra
 *     request. Nothing changes, nothing doubles.
 *   - `0` means «a page» ⇒ page 1 carries the operations we were silently losing. We take them and
 *     say so loudly, because a silent recovery would hide how long it had been happening.
 *
 * ⚠ THE STOP CONDITION READS THE RAW PAGE, NOT THE DEDUP RESULT, and that distinction is load-
 * bearing. Stopping on «this page added nothing new» looks equivalent and is not: `dedupKey` falls
 * back to a content signature when `docId` is empty, and that signature does NOT include the payer's
 * NAME — so two different payers with the same amount, batch `acceptDate`, template purpose and
 * recipient account collide. On the old single-request path such a collision cost one operation; as
 * a stop condition it would end the walk and cost EVERY REMAINING PAGE — rebuilding the silent mass
 * loss this function exists to end. So: an empty page means the data ran out, a page whose raw rows
 * repeat one we already fetched means the bank ignored `pageNo`, and nothing else stops the walk.
 * Dedup still runs — but on the OUTPUT, where collapsing a duplicate is all it can do.
 *
 * Dedup is by `dedupKey` — the SAME key the B24 activity marker uses, so «already seen» here means
 * exactly what it means downstream.
 */
export async function fetchAlfaStatementPages(
  account: string,
  fetchPage: (pageNo: number) => Promise<AlfaStatementResponse>,
  onWalk?: (info: AlfaWalkResult) => void,
  deps: AlfaWalkDeps = {}
): Promise<StatementItem[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => Date.now())
  const startedAt = now()

  const out: StatementItem[] = []
  const seen = new Set<string>()
  // Raw-page signatures, not just the previous one: a bank that cycles 0,1,0,1 would otherwise walk
  // to the cap. Bounded by MAX_ALFA_STATEMENT_PAGES entries of data we are already holding in `out`.
  const pageSigs = new Set<string>()
  let recovered = 0
  let pages = 0
  // ⚠ Initialised to the LOUD value: every exit below assigns explicitly, so this is unreachable
  // today — and if a future edit adds an exit that forgets to, it reports «we may have truncated»
  // rather than «all good». Fail-loud is the safe default for this particular variable.
  let stop: AlfaWalkStop = 'page-cap'

  for (let pageNo = 0; pageNo < MAX_ALFA_STATEMENT_PAGES; pageNo++) {
    const raw = await fetchPage(pageNo)
    const errs = alfaStatementErrors(raw)
    // Unchanged posture: an errored response is NOT «no operations» — fail loud so the job retries.
    // Checked BEFORE the rows, because Alfa can return both, and a partial page must not be mistaken
    // for the end of the data.
    if (errs.length > 0) {
      throw new Error(`fetchBankStatement alfa: account ${account} returned errors — ${errs.map(e => e.message ?? '?').join('; ')}`)
    }
    pages++

    const rows = raw.page ?? []
    if (rows.length === 0) {
      stop = 'exhausted'
      break
    }
    const sig = JSON.stringify(rows)
    if (pageSigs.has(sig)) {
      stop = 'repeat'
      break
    }
    pageSigs.add(sig)

    let fresh = 0
    for (const item of normalizeAlfa(raw, { account })) {
      const key = dedupKey(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
      fresh++
    }
    if (pageNo > 0) recovered += fresh

    if (pageNo >= MAX_ALFA_STATEMENT_PAGES - 1) {
      stop = 'page-cap'
      break
    }
    if (now() - startedAt >= ALFA_WALK_BUDGET_MS) {
      stop = 'time-cap'
      break
    }
    await sleep(ALFA_PAGE_DELAY_MS)
  }

  onWalk?.({ pages, recovered, stop })
  return out
}

/** Per-provider statement API base + path from env (`<PREFIX>_OAUTH_API_BASE`; Alfa path is
 *  the partner API prefix). Returns `null` when the base isn't configured (feature off). */
export function bankApiConfig(provider: BankProviderId): { base: string, statementPath: string } | null {
  // Strip ALL trailing slashes from the base and force a single leading slash on the path,
  // so a `…:8273/` base or a `partner/1.2.0` (no leading slash) env value still joins cleanly.
  const cleanBase = (s: string) => s.replace(/\/+$/, '')
  const asPath = (s: string) => `/${s.replace(/^\/+/, '').replace(/\/+$/, '')}`
  if (provider === 'alfa-by') {
    // Same rule as Prior below: this base carries the polling Bearer, so a scheme typo must fail
    // closed rather than ship the token in clear text. Alfa has no crypto gateway of its own, but
    // the internal-http allowance costs nothing here and keeps ONE rule for «a bank base URL».
    const base = normalizeBankApiBase(process.env.ALFA_OAUTH_API_BASE)
    if (!base) return null
    const prefix = asPath(process.env.ALFA_OAUTH_API_PREFIX?.trim() || '/partner/1.2.0')
    return { base: cleanBase(base), statementPath: `${prefix}/accounts/statement` }
  }
  if (provider === 'prior-by') {
    // Validated, not just trimmed (#455): this base carries the polling Bearer on every tick, so
    // `http://` is accepted only towards an internal gateway — never to a public host.
    const base = normalizeBankApiBase(process.env.PRIOR_OAUTH_API_BASE)
    return base ? { base, statementPath: '/accounts' } : null
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
  /** Priorbank's async create+poll engine (A5b). Injected so the delegation is unit-testable; the
   *  live impl is `fetchPriorStatement`, which owns its own POST/poll transport. */
  fetchPrior: (query: BankFetchQuery, stored: BankToken) => Promise<StatementItem[]>
  /** Тревожный канал обхода страниц (#561): обрыв обхода — окно могло прийти не полностью.
   *  Optional so every existing test double keeps compiling; the live wiring below always
   *  provides it. */
  warn?: (message: string) => void
  /** Спокойный канал того же обхода: сколько страниц собрали. ⚠ Отдельный от `warn` потому, что
   *  на живом проде эта строка печаталась предупреждением на КАЖДОМ тике исправной работы. */
  log?: (message: string) => void
}

const liveDeps: BankFetchDeps = {
  loadToken: (memberId, provider, account) => getBankToken(dbQuery, memberId, provider, account),
  ensureFresh: token => ensureBankToken(token),
  apiConfig: bankApiConfig,
  fetchPrior: (query, stored) => fetchPriorStatement(query, stored),
  warn: message => log.warning(message),
  log: message => log.info(message),
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
 * NOT "no operations", per alfaStatement.ts). Prior delegates to `fetchPriorStatement` (the async
 * create+poll engine), which applies the same fail-loud posture.
 */
export async function fetchBankStatement(query: BankFetchQuery, deps: BankFetchDeps = liveDeps): Promise<StatementItem[]> {
  const stored = await deps.loadToken(query.memberId, query.provider, query.account)
  if (!stored) return [] // not connected → nothing to fetch (inert, no throw)

  const cfg = deps.apiConfig(query.provider)
  if (!cfg) throw new Error(`fetchBankStatement: ${query.provider} API base not configured (set <PREFIX>_OAUTH_API_BASE)`)

  if (query.provider === 'alfa-by') {
    const token = await deps.ensureFresh(stored)
    return fetchAlfaStatementPages(
      query.account,
      async (pageNo) => {
        const url = `${cfg.base}${cfg.statementPath}?${alfaStatementQuery(query.account, query.dateFrom, query.dateTo, pageNo).toString()}`
        return await deps.getJson(url, token.accessToken) as AlfaStatementResponse
      },
      // ⚠ Уровень выбирает САМ `alfaWalkNotice`: обрыв обхода — тревога (окно могло прийти не
      // полностью), штатно собранные страницы — факт. Прежде оба случая шли WARNING, и на живом
      // проде это означало предупреждение на каждом тике о том, что уже починено.
      // ⚠ The account is `logSafe`'d exactly like worker.ts's `[fetch]` line — it is bank-supplied
      // text on its way into a log, and the two lines must not disagree about that.
      (info) => {
        const notice = alfaWalkNotice(`alfa ${logSafe(query.account)} ${query.dateFrom}..${query.dateTo}`, info)
        if (notice) (notice.level === 'warn' ? deps.warn : (deps.log ?? deps.warn))?.(notice.text)
      }
    )
  }

  if (query.provider === 'prior-by') {
    // Async create+poll engine (A5b) — its own POST/poll transport; token refresh happens inside.
    return deps.fetchPrior(query, stored)
  }

  // No online-fetch path for this provider (manual import only). Fail loud (not a silent []).
  throw new Error(`fetchBankStatement: ${query.provider} online fetch not supported`)
}
