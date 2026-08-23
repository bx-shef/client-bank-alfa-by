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
// GATING: the engine is reachable only for an account with a STORED Prior token. Prior IS in the
// poll planner's POLLABLE_PROVIDERS (server/queue/cron.ts) — both poller-level gaps that once held
// it back are closed: rate is accounted PER REQUEST (`providerJobRate`, a Prior job costs ~10 HTTP)
// and the long create+poll cycle occupies its own queue `bank-fetch-prior` with its own slots, so it
// cannot starve Alfa. Whether the timer actually runs is a separate switch (`CRON_REAL_POLL`,
// default off), and prod additionally needs the BY-crypto TLS СКЗИ (docs/PRIOR_API.md, issue #41).
// Verified by unit tests against a mocked transport; a live sandbox run needs the owner's creds.

import { randomUUID } from 'node:crypto'
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
  PRIOR_MAX_WINDOW_DAYS,
  priorResourceHeaders,
  priorWriteHeaders
} from '../../app/utils/priorOauth'
import { normalizePriorTransactionList, type PriorTransactionListResponse } from '../../app/utils/priorStatement'
import { dedupKey } from '../../app/utils/statement'
import { ensureBankToken } from './ensureBankToken'
import { normalizeBankApiBase } from '../../app/utils/bankGatewayUrl'
import type { BankToken } from './bankTokenStore'
import type { BankFetchQuery } from './bankFetch'
import { useServerLogger } from './serverLogger'
import { logSafe } from './logSafe'

const log = useServerLogger('fetch')

/** We fetch TRANSACTIONS (not statements): the response is `data.transaction[]`, exactly what
 *  `normalizePrior` consumes. Both endpoints share the create+poll shape (PriorResourceKind). */
const RESOURCE_KIND = 'transactions' as const

/**
 * Poll budget for the async resource.
 *
 * ⚠ MEASURED ON PRODUCTION (2026-08-20): the old budget — 8 attempts × a flat 1500 ms, about ten
 * seconds in total — never once saw a ready transaction list. Every poll cycle ended in
 * `transactions not ready after 8 polls`, on every tick, all night.
 *
 * Ten seconds was never the intent. The whole reason Prior has its OWN queue with its OWN slots is
 * that its create+poll is, in this repo's own words, "minutes-long" and must not head-of-line block
 * Alfa — but the constant next to that comment allowed ten seconds. The numbers were tuned against
 * the sandbox and quietly carried over to production, where the window is 3 days of real data.
 *
 * ⚠ There are TWO plausible causes and the old code could not tell them apart, which is half the
 * problem: either the bank is still generating (poll returns pending), or it is THROTTLING us —
 * `isRetryablePollStatus` counts 429 as "not an answer yet", and hammering a hard per-account
 * throttle every 1.5 s is a good way to stay throttled. Backing off exponentially helps in both
 * cases, and the failure message now reports the status breakdown so the next run says which it was.
 *
 * ⚠ Each JOB attempt creates a NEW resource (create+poll is one function), so giving up early is
 * not free: we abandon a list the bank is still building and ask for another one. Better to wait.
 */
export const PRIOR_POLL_MAX_ATTEMPTS = 20
/** First delay; subsequent ones grow by {@link PRIOR_POLL_BACKOFF} up to {@link PRIOR_POLL_MAX_DELAY_MS}. */
export const PRIOR_POLL_DELAY_MS = 1500
export const PRIOR_POLL_BACKOFF = 1.6
export const PRIOR_POLL_MAX_DELAY_MS = 8000
/**
 * Hard ceiling on the whole poll phase, in wall-clock terms.
 *
 * ⚠ Deliberately BINDING with the shipped constants: at 8 s a poll, the attempt count alone would
 * allow ~134 s, so this cuts the last couple of attempts. That is the point — a bound that the
 * shipped configuration can never reach is decoration, not a guard: it cannot be tested, and it
 * would silently stop protecting anything the moment someone raised the attempt count. Mutation
 * testing caught exactly that: with a loose ceiling, deleting the check changed nothing.
 *
 * Two independent limits (attempts AND time) so that tuning either one cannot turn a job into an
 * unbounded worker hold.
 */
export const PRIOR_POLL_BUDGET_MS = 120_000

/**
 * Размеры страниц, на которых API обычно обрезает выдачу молча.
 *
 * ⚠ Заведено по живому прогону (2026-08-20): опрос вернул РОВНО 100 операций, и так двенадцать
 * раз подряд. Круглое число — классическая подпись страничного лимита, а не совпадение. Проверить
 * по коду нельзя: в запрос мы страницу не передаём, а из ответа читаем ТОЛЬКО `data.transaction[]`
 * — тип объявлен как «минимальная форма», поэтому `meta`/`links`/`totalCount`, если банк их шлёт,
 * отбрасываются, не оставляя следа.
 *
 * Цена ошибки несимметрична: если лимит есть, мы теряем платежи **молча**, а строка лога при этом
 * говорит «100 ops» и выглядит здоровой. Поэтому при попадании на границу печатаем ИМЕНА полей
 * конверта, которые не читаем, — следующий же опрос скажет, есть ли там пагинация.
 *
 * ⚠ Только имена ключей, без значений: значения — это финансовые ПДн (`docs/PRIVACY.md`).
 */
export const SUSPICIOUS_PAGE_SIZES: readonly number[] = [50, 100, 200, 500, 1000]

/** Похоже ли, что выдачу обрезали страницей. Чистая — проверяется без банка. */
export function looksLikePageBoundary(count: number): boolean {
  return SUSPICIOUS_PAGE_SIZES.includes(count)
}

/** Имена полей ответа, которые мы НЕ читаем, — чтобы увидеть пагинацию, если она есть. */
export function unreadEnvelopeKeys(body: unknown): string[] {
  if (!body || typeof body !== 'object') return []
  const top = Object.keys(body as Record<string, unknown>).filter(k => k !== 'data')
  const data = (body as { data?: unknown }).data
  const inner = data && typeof data === 'object'
    ? Object.keys(data as Record<string, unknown>).filter(k => k !== 'transaction' && k !== 'accountId')
    : []
  return [...top.map(k => k), ...inner.map(k => `data.${k}`)]
}

/** Runaway backstop for page walking — not an expected limit (mirrors MAX_ALFA_STATEMENT_PAGES). */
export const MAX_PRIOR_STATEMENT_PAGES = 20

/** Courtesy gap between page requests of one materialized list. Paid only between pages. */
export const PRIOR_PAGE_DELAY_MS = 500

/** Wall-clock ceiling on the whole page walk (the poll phase has its own, separate budget). */
export const PRIOR_WALK_BUDGET_MS = 20_000

/**
 * The next-page URL from a transaction-list envelope, resolved against OUR base — or `null`.
 *
 * ⚠ Measured on production (2026-08-22): the envelope carries `links` + `meta` we never read, and
 * every tick returns EXACTLY 100 operations — the same silent truncation #561 chased on Alfa, but
 * with the pagination pointer sitting right there in the response. This reads it.
 *
 * ⚠ SECURITY: the URL is bank-SUPPLIED text and the request that follows it carries our Bearer.
 * A cross-origin `next` (misbehaving bank, tampered response) must never receive the token — so
 * the link is resolved against `base` and REJECTED unless its origin equals the base's origin.
 * The path+query are the bank's; the origin is always ours.
 */
export function priorNextPageUrl(body: unknown, base: string): string | null {
  if (!body || typeof body !== 'object') return null
  const links = (body as { links?: unknown }).links
  if (!links || typeof links !== 'object') return null
  const rawNext = (links as { next?: unknown }).next
  const next = typeof rawNext === 'string'
    ? rawNext
    : (rawNext && typeof rawNext === 'object' ? (rawNext as { href?: unknown }).href : null)
  if (typeof next !== 'string' || next.trim() === '') return null
  try {
    const baseUrl = new URL(base)
    const resolved = new URL(next, baseUrl)
    if (resolved.origin !== baseUrl.origin) return null
    return resolved.toString()
  } catch {
    return null
  }
}

/** Why a Prior page walk stopped. Only `exhausted` (the bank offered no next link) means the data
 *  honestly ran out — EVERYTHING else, `repeat` included, means the window may be incomplete and
 *  must be said out loud. */
export type PriorWalkStop = 'exhausted' | 'repeat' | 'page-cap' | 'time-cap' | 'foreign-next' | 'not-ready'

/** Что сказать в лог об обходе страниц и НАСКОЛЬКО громко. */
export interface WalkNotice {
  level: 'info' | 'warn'
  text: string
}

export interface PriorWalkResult {
  pages: number
  /** Operations that came from pages 2..N — rows the single-page version was losing. */
  recovered: number
  stop: PriorWalkStop
}

/**
 * Why the walk stopped and WHAT TO DO — exhaustive by construction, so a new `PriorWalkStop` will
 * not compile until someone decides what to tell the operator about it.
 *
 * ⚠ The advice is per-cause because «следующий тик заберёт хвост сам» is TRUE FOR ONE OF THEM. A
 * throttled page really does self-heal (the next tick creates a fresh resource). A structural
 * 20-page account, a systematically slow bank, a moved bank domain and a looping cursor repeat
 * identically every tick — telling the operator to wait there teaches them to ignore the line.
 * The Alfa sibling already words its two causes as actions; Prior's four must too.
 */
const TRUNCATION_ADVICE: Record<PriorWalkStop, string> = {
  'exhausted': '', // never rendered — `exhausted` is the one silent stop
  'repeat': 'links.next ведёт на уже пройденную страницу: банк зациклился. Повторяется каждый тик — смотрите ответ банка, ждать бесполезно.',
  'page-cap': `упёрлись в потолок ${MAX_PRIOR_STATEMENT_PAGES} страниц. Если повторяется — сузьте CRON_LOOKBACK_DAYS или поднимите потолок.`,
  'time-cap': `исчерпан бюджет ${Math.round(PRIOR_WALK_BUDGET_MS / 1000)} с. Если повторяется — банк отвечает медленно: сузьте окно.`,
  'foreign-next': 'links.next указывает на ЧУЖОЙ origin — токен туда не понесём. Это НАСТРОЙКА, а не задержка: проверьте адрес банка и шлюз.',
  'not-ready': 'следующая страница не готова или троттлится — единственный случай, когда следующий тик действительно заберёт хвост сам.'
}

/**
 * What to say in the log about a finished walk — `null` when there is nothing worth saying.
 * Pure and separate from the loop for the same reason `alfaWalkNotice` is: «when do we log» is the
 * part that silently rots inside a transport callback. No literal `[fetch]`/`[prior-page]` prefix —
 * the logger prints the channel itself.
 */
export function priorWalkNotice(label: string, info: PriorWalkResult): WalkNotice | null {
  // ⚠ ONLY `exhausted` is silent. `repeat` used to be silent too, on the reasoning that a looping
  // bank means «done» — and that was wrong twice over: a loop is precisely the case where we do NOT
  // know whether we saw everything, and treating it as a clean end rebuilt the silent truncation
  // this whole file exists to end. Measured: the walk stopped early and logged nothing.
  const truncated = info.stop !== 'exhausted'
  if (info.recovered <= 0 && !truncated) return null
  const parts: string[] = []
  if (info.recovered > 0) {
    parts.push(
      `страниц: ${info.pages}, со 2-й и дальше добрано операций: ${info.recovered}`
    )
  }
  if (truncated) {
    const why = TRUNCATION_ADVICE[info.stop]
    parts.push(
      `ОБХОД СТРАНИЦ ОБОРВАН на ${info.pages}-й — выписка за это окно могла прийти НЕ ПОЛНОСТЬЮ.`
      + ` ${why} (#561)`
    )
  }
  // ⚠ Уровень РАЗНЫЙ, и это замечание владельца по живому логу: строка о добранных страницах
  // печаталась WARNING на КАЖДОМ тике штатной работы («168 операций со страниц 2..3»), то есть
  // предупреждала о том, что уже починено, и забивала поиск настоящих проблем. Тревога здесь одна
  // — ОБРЫВ обхода: окно могло прийти не полностью. Штатный сбор страниц — просто факт.
  return { level: truncated ? 'warn' : 'info', text: `${label}: ${parts.join(' | ')}` }
}

/**
 * Walk the materialized transaction list by `links.next` until the bank runs out.
 *
 * ⚠ THE STOP CONDITION NEVER READS THE DEDUP RESULT, and that distinction is load-bearing:
 * `dedupKey` falls back to a content signature that omits the payer's NAME, so a colliding page
 * must collapse in the OUTPUT without ending the walk.
 *
 * ⚠ THE CYCLE DETECTOR IS THE URL, NOT THE PAGE CONTENT — and this is where Prior deliberately
 * differs from `fetchAlfaStatementPages`. Alfa numbers its own pages (`pageNo`), so identical
 * CONTENT at a different page number is the only way to see «the bank ignored the cursor». Prior
 * hands us the cursor itself, so a loop is literally «next points where we have already been»,
 * and content-identity is a bad proxy for it: two EMPTY pages are byte-identical without being a
 * loop at all. Measured — page1=[a], page2=[], page3=[], page4=[real] ended the walk at page 3
 * and never requested page 4, losing real operations in silence.
 *
 * ⚠ A non-ready/throttled page STOPS the walk loudly instead of failing the job: throwing would
 * re-create the whole resource on retry (the create+poll is the expensive part), while the rolling
 * poll window re-fetches every tick anyway — the tail lands on the next tick. A page ERROR still
 * throws: that is a broken answer, not a slow one.
 */
export async function walkPriorPages(
  firstBody: unknown,
  account: string,
  base: string,
  fetchPage: (url: string) => Promise<PriorPollReply>,
  onWalk?: (info: PriorWalkResult) => void,
  walkDeps: { sleep?: (ms: number) => Promise<void>, now?: () => number } = {}
): Promise<StatementItem[]> {
  const sleep = walkDeps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = walkDeps.now ?? (() => Date.now())
  const startedAt = now()

  const out: StatementItem[] = []
  const seen = new Set<string>()
  /** URLs already fetched in THIS walk — the loop detector (see the doc above). */
  const visited = new Set<string>()
  let recovered = 0
  let pages = 0
  // No initializer ON PURPOSE: every exit below is a `break` that assigns, so definite-assignment
  // analysis makes a future exit that forgets to assign a COMPILE error — stricter than the Alfa
  // walk's fail-loud default, which only mislabels the outcome at runtime.
  let stop: PriorWalkStop

  let body = firstBody
  for (;;) {
    pages++
    let fresh = 0
    for (const item of normalizePriorTransactionList(body as PriorTransactionListResponse, { account })) {
      const key = dedupKey(item)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
      fresh++
    }
    if (pages > 1) recovered += fresh

    const rawNext = priorNextPageUrl(body, base)
    if (rawNext === null) {
      // Distinguish «no link» from «link we REFUSED»: a cross-origin next is the one case where
      // absent and rejected must not read the same — the second means the window IS incomplete.
      //
      // ⚠ «Present» means a NON-EMPTY STRING (or an {href} carrying one), not merely `!== undefined`.
      // `links: { next: null }` and `next: ''` are ordinary REST for «no more pages»; calling them a
      // refusal mislabelled a clean end as `foreign-next`, printed «указывает на ЧУЖОЙ origin» about
      // a link that did not exist, and — worse — suppressed the round-count backstop below, which
      // gates on `stop === 'exhausted'`. So the backstop went quiet exactly where it was designed
      // to speak. Found by review on real-shaped input, not by mutation.
      const rawLink = (body as { links?: { next?: unknown } } | undefined)?.links?.next
      const linkText = typeof rawLink === 'string'
        ? rawLink
        : (rawLink && typeof rawLink === 'object' ? (rawLink as { href?: unknown }).href : undefined)
      stop = typeof linkText === 'string' && linkText.trim() !== '' ? 'foreign-next' : 'exhausted'
      break
    }
    if (visited.has(rawNext)) {
      stop = 'repeat'
      break
    }
    if (pages >= MAX_PRIOR_STATEMENT_PAGES) {
      stop = 'page-cap'
      break
    }
    if (now() - startedAt >= PRIOR_WALK_BUDGET_MS) {
      stop = 'time-cap'
      break
    }
    visited.add(rawNext)
    await sleep(PRIOR_PAGE_DELAY_MS)

    const reply = await fetchPage(rawNext)
    if (isRetryablePollStatus(reply.status)) {
      stop = 'not-ready'
      break
    }
    const verdict = classifyPriorPoll(reply.body)
    if (verdict.status === 'error') {
      throw new Error(`fetchPriorStatement: page ${pages + 1} error for account ${account} (HTTP ${reply.status}) — ${verdict.codes.join('; ')}`)
    }
    if (verdict.status !== 'ready') {
      stop = 'not-ready'
      break
    }
    body = reply.body
  }

  onWalk?.({ pages, recovered, stop })
  return out
}

/** Delay before the poll after `attempt` (0-based): exponential, capped. Pure — the shape is the
 *  thing being reasoned about, so it is testable without a clock or a bank. */
export function priorPollDelayMs(attempt: number): number {
  const raw = PRIOR_POLL_DELAY_MS * Math.pow(PRIOR_POLL_BACKOFF, Math.max(0, attempt))
  return Math.min(PRIOR_POLL_MAX_DELAY_MS, Math.round(raw))
}

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
  /**
   * Diagnostic line, emitted ONLY on a successful poll (how many polls, how long we waited).
   *
   * ⚠ Optional on purpose — the engine must stay usable from scripts and tests without a logger —
   * but it is the only place the REAL generation time is ever known. The ten-second budget that
   * failed all night was a guess; without this number the next budget would be a guess too.
   * Carries no statement content: counters only.
   */
  log?: (line: string) => void
  /** Loud channel for the page walk's two discoveries (#561): recovered rows and a cut-short walk.
   *  Optional for the same reason `log` is; the live wiring provides it. */
  warn?: (line: string) => void
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

/**
 * Read the OB base from env (`PRIOR_OAUTH_API_BASE`); `null` when unset OR unusable.
 *
 * ⚠ This is the POLLING path — it runs on every cron tick with a live `Authorization: Bearer`,
 * unlike the one-shot connect flow. Validating only there would leave the frequent, automated
 * traffic on a raw value: a cutover typo (`http://` to the public bank host) would keep shipping
 * the token in clear text with nothing to notice it. Same rules everywhere (#455).
 */
export function priorApiBaseFromEnv(): string | null {
  return normalizeBankApiBase(process.env.PRIOR_OAUTH_API_BASE)
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
      headers: priorWriteHeaders(accessToken, randomUUID(), randomUUID()),
      timeout: 20_000
    })
  },
  getJson: async (url, accessToken) => {
    const fetchJson = $fetch as unknown as (
      url: string,
      opts: { method: string, headers: Record<string, string>, timeout: number }
    ) => Promise<unknown>
    return fetchJson(url, { method: 'GET', headers: priorResourceHeaders(accessToken, randomUUID()), timeout: 20_000 })
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
      headers: priorResourceHeaders(accessToken, randomUUID()),
      timeout: 20_000,
      ignoreResponseError: true
    })
    return { status: res.status, body: res._data }
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  // Diagnostic only, and only on success — see the port's doc.
  log: line => log.info(line),
  warn: line => log.warning(line)
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
  // ⚠ Считаем, ЧЕМ именно отвечал банк. Прежнее сообщение говорило только «не готово за N опросов»,
  // и по нему нельзя было отличить «банк всё ещё считает» от «банк нас троттлит» — а лечатся эти
  // два случая противоположно (ждать дольше против ходить реже). Ночь на проде прошла именно так:
  // одинаковая строка на каждом тике и никакого способа понять причину.
  let throttled = 0
  let pending = 0
  let lastStatus = 0
  let waited = 0
  for (let attempt = 0; attempt < PRIOR_POLL_MAX_ATTEMPTS; attempt++) {
    const { status, body } = await deps.pollJson(pollUrl, token.accessToken)
    lastStatus = status
    if (isRetryablePollStatus(status)) {
      throttled++
    } else {
      const verdict = classifyPriorPoll(body)
      if (verdict.status === 'ready') {
        // 3) NORMALIZE + WALK PAGES (ctx.account = OUR stored account key — the statement belongs
        //    to it, not to the bank's internal id — so downstream dedup keys stay stable).
        // ⚠ Печатаем, сколько ждали: без этого числа калибровать бюджет можно только гаданием, а
        // именно гадание и привело к десяти секундам. Успех — единственный момент, когда реальная
        // длительность известна.
        deps.log?.(`[prior-poll] ready after ${attempt + 1} polls, ${Math.round(waited / 1000)}s waited`)
        // ⚠ Ходим по `links.next` — замерено на проде (#561): каждый тик приносил РОВНО 100
        // операций, а в конверте лежали непрочитанные `links`/`meta`. Страницы 2..N раньше
        // терялись молча.
        let walk: PriorWalkResult | undefined
        const items = await walkPriorPages(
          body,
          query.account,
          base,
          nextUrl => deps.pollJson(nextUrl, token.accessToken),
          (info) => {
            walk = info
            // ⚠ Уровень выбирает сам `priorWalkNotice`: тревога — только ОБРЫВ обхода, штатно
            // собранные страницы идут INFO. Прежде WARNING печаталось на каждом тике исправной
            // работы, то есть предупреждало о починенном и забивало поиск настоящих проблем.
            // ⚠ logSafe exactly like the Alfa sibling and worker.ts's [fetch] line: an account key
            // on its way into a log is bank-supplied text, and the two lines must not disagree.
            const notice = priorWalkNotice(`${logSafe(query.account)} ${from}..${to}`, info)
            if (notice) {
              const sink = notice.level === 'warn' ? (deps.warn ?? deps.log) : (deps.log ?? deps.warn)
              sink?.(`[prior-page] ${notice.text}`)
            }
          },
          { sleep: deps.sleep }
        )
        // Бэкстоп — только когда пагинации в конверте НЕ БЫЛО (одна страница, честный конец), а
        // число подозрительно круглое: лимит без ссылки «дальше» иначе снова стал бы невидимым.
        // ⚠ Гейт по состоянию обхода обязателен: без него строка «links.next НЕТ» печаталась бы и
        // после честного обхода трёх страниц, чей итог случайно попал на круглое число.
        if (walk?.pages === 1 && walk.stop === 'exhausted' && looksLikePageBoundary(items.length)) {
          const unread = unreadEnvelopeKeys(body)
          deps.log?.(
            `[prior-page] ⚠ ровно ${items.length} операций и links.next НЕТ — возможен лимит без пагинации. `
            + `Непрочитанные поля ответа: ${unread.length ? unread.join(', ') : 'нет'}`
          )
        }
        return items
      }
      if (verdict.status === 'error') {
        throw new Error(`fetchPriorStatement: poll error for account ${query.account} (HTTP ${status}) — ${verdict.codes.join('; ')}`)
      }
      pending++
    }
    // pending (or a throttled/blipped status) → wait and retry (skip the wait after the last attempt).
    if (attempt >= PRIOR_POLL_MAX_ATTEMPTS - 1) break
    const delay = priorPollDelayMs(attempt)
    // ⚠ Потолок по ВРЕМЕНИ, а не только по числу попыток: иначе правка одной константы может
    // незаметно превратить задачу в бесконечно висящую и занять слот воркера навсегда.
    if (waited + delay > PRIOR_POLL_BUDGET_MS) break
    await deps.sleep(delay)
    waited += delay
  }
  throw new Error(
    `fetchPriorStatement: ${RESOURCE_KIND} not ready for account ${query.account} — `
    + `${pending} pending, ${throttled} throttled/5xx, last HTTP ${lastStatus}, ${Math.round(waited / 1000)}s waited`
  )
}
