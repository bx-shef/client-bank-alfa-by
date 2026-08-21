// The BANK side of the «наш счёт ↔ счёт в банке» matrix (#494): ask each connected bank which
// accounts its consent actually covers.
//
// WHY ASK THE BANK AT ALL. Today the admin TYPES the account number after connecting, and a typo
// produces no error anywhere: polling runs against a number the bank has never heard of, or the
// requisite in CRM differs by one character and `findMyCompany` finds nothing. Both banks already
// answer the question — Alfa with `GET /accounts/`, Prior with the OB `GET /accounts` that
// `resolvePriorAccountId` was already calling for its own purposes. This module turns that into a
// list the UI can show, so «which account?» becomes a click instead of a transcription.
//
// ⚠ NUMBERS ARE RETURNED VERBATIM. The whole point of the matrix is to expose the case where the
// two sides differ only by whitespace or case — the requisite lookup compares the stored value
// character by character, so `BY00 BANK …` genuinely is a different account from `BY00BANK…`.
// Normalising here would make the screen agree with itself while the import stayed broken. The
// comparison happens once, in `app/utils/bankAccountMatrix.ts`, and it keeps the two cases apart.
//
// ⚠ FAIL SOFT, PER PROVIDER. A bank that errors (expired consent, gateway down, dead grant) must
// not blank the whole screen: the CRM half is still the more actionable half, and «банк не ответил»
// is itself a finding worth showing. Each provider carries its own optional `error`, and the caller
// renders what it got.
//
// Pure over injected I/O (DI) like the rest of `server/utils` — unit-testable without a bank.

import type { BankProviderId } from '../../app/types/statement'
import type { BankSideAccount } from '../../app/utils/bankAccountMatrix'
import { extractAccounts, PRIOR_API_PREFIXES } from '../../app/utils/priorOauth'
import { isPendingAccountKey } from '../../app/utils/bankAccountKey'
import { isLockTimeout } from './bankRefreshLock'
import { sanitizeForLog } from './logSanitize'
import type { BankToken } from './bankTokenStore'

/** Providers we can ask. `manual` has no API; a provider absent here yields no bank side at all
 *  (and therefore no `bank-only` rows), which is the honest answer rather than an empty list. */
export const LISTABLE_PROVIDERS: readonly BankProviderId[] = ['alfa-by', 'prior-by']

/** One provider's answer. `accounts` is empty AND `error` set when we could not ask. */
export interface BankSideProviderResult {
  provider: BankProviderId
  accounts: BankSideAccount[]
  /** Human-readable reason the bank side is unknown. Sanitised — it reaches an admin's screen. */
  error?: string
}

export interface BankSideListDeps {
  /** Every stored token of the portal (pending ones included — see the note in `pickToken`). */
  tokens: (memberId: string) => Promise<BankToken[]>
  ensureFresh: (token: BankToken) => Promise<BankToken>
  /** Provider API origin, or `null` when the provider isn't configured on this deployment. */
  apiBase: (provider: BankProviderId) => string | null
  /** GET a JSON resource with a Bearer token. Must not leak the auth on error. */
  getJson: (url: string, accessToken: string) => Promise<unknown>
}

/** Extract the account list from Alfa's `GET /accounts/` envelope (`{accounts:[{number,currIso}]}`).
 *  Pure. Rows without a `number` are dropped — an account we cannot name is not a matrix row. */
export function extractAlfaAccounts(raw: unknown): BankSideAccount[] {
  const list = (raw as { accounts?: unknown } | null)?.accounts
  if (!Array.isArray(list)) return []
  const out: BankSideAccount[] = []
  for (const row of list) {
    const acc = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>
    const number = `${acc.number ?? ''}`.trim()
    if (!number) continue
    const currency = `${acc.currIso ?? acc.currency ?? ''}`.trim()
    out.push(currency ? { number, currency } : { number })
  }
  return out
}

/** Build the accounts-list URL for a provider. Alfa's partner prefix is configurable (same env
 *  the statement path uses); Prior's OB prefix is fixed by the standard. */
export function accountsUrl(provider: BankProviderId, base: string): string {
  if (provider === 'prior-by') return `${base}${PRIOR_API_PREFIXES.OB}/accounts`
  const prefix = `/${(process.env.ALFA_OAUTH_API_PREFIX?.trim() || '/partner/1.2.0').replace(/^\/+/, '').replace(/\/+$/, '')}`
  return `${base}${prefix}/accounts/`
}

/**
 * Choose which stored token to ask with. Any token of the provider works — the consent covers the
 * whole set of accounts, not one row — so we take the one whose access token lives longest, i.e.
 * the most recently obtained. PENDING connections (#407) are explicitly eligible and in fact the
 * common case: the admin has just authorised in the bank and has not picked an account yet, which
 * is exactly when this list is needed.
 */
export function pickToken(tokens: readonly BankToken[], provider: BankProviderId): BankToken | null {
  const mine = tokens.filter(t => t.provider === provider)
  if (!mine.length) return null
  return mine.reduce((best, t) => (t.expiresAt > best.expiresAt ? t : best))
}

/** Whether the portal has any connection at all to this provider (pending included). */
export function hasConnection(tokens: readonly BankToken[], provider: BankProviderId): boolean {
  return tokens.some(t => t.provider === provider)
}

/** Ask ONE bank for its account list. Never throws — the failure is the result. */
async function askProvider(
  provider: BankProviderId,
  stored: BankToken,
  deps: BankSideListDeps
): Promise<BankSideProviderResult> {
  const base = deps.apiBase(provider)
  if (!base) return { provider, accounts: [], error: 'банк не настроен на этом сервере' }
  try {
    const fresh = await deps.ensureFresh(stored)
    const raw = await deps.getJson(accountsUrl(provider, base), fresh.accessToken)
    const accounts = provider === 'prior-by'
      // Prior addresses accounts by an opaque id; the IBAN lives in `identification`. A row with
      // no identification is unusable as a matrix row (nothing to compare against a requisite),
      // so it is dropped rather than shown as an empty line.
      ? extractAccounts(raw)
          .map(a => ({ number: (a.identification ?? '').trim(), currency: a.currency }))
          .filter(a => a.number)
      : extractAlfaAccounts(raw)
    // Tag every row with its bank. The matrix flattens both banks into one list, and an untagged
    // row could then be offered as the account of the OTHER bank's connection — see the note on
    // `BankSideAccount.provider`.
    return { provider, accounts: accounts.map(a => ({ ...a, provider })) }
  } catch (e) {
    // ⚠ Исчерпание ожидания лока — ШТАТНЫЙ исход, а не поломка: тот же `bankrefresh:` держит
    // плановое продление токена, у которого потолок POST к банку 15 с, а мы ждём пару секунд
    // (#539). Без этой ветки админ увидел бы сырое `canceling statement due to lock timeout` —
    // текст, который не подсказывает ничего и вдобавок несёт имена таблиц.
    if (isLockTimeout(e)) {
      // ⚠ Формулировка та же по существу, что у близнеца на 503 от `/api/bank/set-account`
      // (у клиентского — предложение с заглавной и точкой, здесь — вставка в шаблон алерта;
      // совпадение сверяет тест, а не глаз)
      // (`setAccountError.ts`): исход один и тот же — лок держит обновление токена, — а появиться
      // оба могут на одном экране, в одной карточке подключения. И не «банк опрашивается»:
      // держатель — продление токена, оно идёт независимо от автоопроса, поэтому на портале с
      // выключенным опросом такой текст спорил бы с экраном готовности.
      return { provider, accounts: [], error: 'подключение сейчас обновляется — повторите через несколько секунд' }
    }
    // The message reaches an admin's screen, so it is sanitised (CRLF/length) — a bank error
    // body is external text. The Bearer never appears in these messages (the route's `getJson`
    // keeps the upstream error in `cause`), and we surface `message` only.
    return { provider, accounts: [], error: sanitizeForLog((e as Error)?.message ?? 'ошибка запроса') }
  }
}

/**
 * Ask every connected bank for its account list. Providers the portal has NOT connected are
 * skipped entirely (no row, no error) — «вы не подключали Приор» is not a problem to report.
 *
 * ⚠ THE BANKS ARE ASKED IN PARALLEL, and that is a timeout requirement rather than a speed
 * preference. Sequentially, two connected banks at a 15 s transport timeout add up to 30 s — the
 * exact ceiling of the standard nginx profile this route runs under. The admin would then get a
 * bare 504 instead of our own «банк не ответил» line, i.e. lose the very diagnostic the screen
 * exists to give. In parallel the worst case stays one timeout, whatever the number of banks.
 * Order is preserved (`Promise.all` over `LISTABLE_PROVIDERS`), so the screen is stable.
 */
export async function listBankSideAccounts(memberId: string, deps: BankSideListDeps): Promise<BankSideProviderResult[]> {
  const tokens = await deps.tokens(memberId)
  const asks = LISTABLE_PROVIDERS
    .map(provider => ({ provider, stored: pickToken(tokens, provider) }))
    .filter((x): x is { provider: BankProviderId, stored: BankToken } => x.stored !== null)
    .map(({ provider, stored }) => askProvider(provider, stored, deps))
  return Promise.all(asks)
}

/** Account keys the portal currently holds a token for, EXCLUDING pending ones — a pending row is
 *  not a connected account (it has no number yet) and would otherwise light up every matrix row as
 *  «подключено». */
export function connectedKeys(tokens: readonly BankToken[]): string[] {
  return tokens.filter(t => !isPendingAccountKey(t.accountKey)).map(t => t.accountKey)
}
