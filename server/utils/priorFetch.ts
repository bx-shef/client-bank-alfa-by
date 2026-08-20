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
import { ensureBankToken } from './ensureBankToken'
import { normalizeBankApiBase } from '../../app/utils/bankGatewayUrl'
import type { BankToken } from './bankTokenStore'
import type { BankFetchQuery } from './bankFetch'

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
  log: line => console.log(line)
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
        // 3) NORMALIZE (ctx.account = OUR stored account key — the statement belongs to it, not to
        //    the bank's internal id — so downstream dedup keys stay stable across id changes).
        // ⚠ Печатаем, сколько ждали: без этого числа калибровать бюджет можно только гаданием, а
        // именно гадание и привело к десяти секундам. Успех — единственный момент, когда реальная
        // длительность известна.
        deps.log?.(`[prior-poll] ready after ${attempt + 1} polls, ${Math.round(waited / 1000)}s waited`)
        const items = normalizePriorTransactionList(body as PriorTransactionListResponse, { account: query.account })
        // ⚠ Подозрение на обрезанную страницу — говорим об этом ГРОМКО и сразу с уликами: сколько
        // пришло и какие поля конверта мы не читаем. Молчаливая потеря платежей выглядит здоровым
        // логом, и заметить её можно только сверкой с банком вручную.
        if (looksLikePageBoundary(items.length)) {
          const unread = unreadEnvelopeKeys(body)
          deps.log?.(
            `[prior-page] ⚠ ровно ${items.length} операций — возможен страничный лимит. `
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
