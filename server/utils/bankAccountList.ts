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

// ⚠ Сверка счетов СОЗНАТЕЛЬНО не смотрит на паузу автоопроса (#576). Пауза останавливает
// АВТОМАТИЧЕСКИЙ поход за выпиской; сверка — разовое действие администратора, который прямо сейчас
// открыл настройки и хочет увидеть, что банк вообще отдаёт. Отказать ему потому, что опрос на
// паузе, значило бы спрятать единственный экран, по которому он проверяет, всё ли настроено.
// Записано явно, чтобы следующий читатель не счёл это забытым путём (находка ревью).

import { isBankUnauthorized } from './bankFetch'
import type { BankProviderId } from '../../app/types/statement'
import type { BankSideAccount } from '../../app/utils/bankAccountMatrix'
import { extractAccounts, priorResourceHeaders, PRIOR_API_PREFIXES } from '../../app/utils/priorOauth'
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
  /**
   * Сколько ПОДКЛЮЧЕНИЙ этого банка мы спросили и сколько из них не ответили.
   *
   * ⚠ Нужны ровно для честной формулировки, и это не украшение. У портала может быть несколько
   * независимых подключений к одному банку (два ключа API Альфы, два согласия Приора — разные
   * юрлица клиента). Когда одно ответило, а другое нет, старый текст «список счетов этого банка
   * сейчас неизвестен» становится ЛОЖНЫМ: часть счетов мы как раз знаем. Одного поля `error` для
   * различения мало — оно одинаково и когда молчат все, и когда молчит один из трёх.
   */
  asked: number
  failed: number
}

export interface BankSideListDeps {
  /** Every stored token of the portal (pending ones included — see the note in `pickGrantTokens`). */
  tokens: (memberId: string) => Promise<BankToken[]>
  /** Свежий токен подключения. `force` — РЕАКТИВНО, после отказа банка: обновить, а при
   *  сохранённом ключе API выпустить пару заново, даже если по часам токен ещё жив. */
  ensureFresh: (token: BankToken, opts?: { force?: boolean }) => Promise<BankToken>
  /** Provider API origin, or `null` when the provider isn't configured on this deployment. */
  apiBase: (provider: BankProviderId) => string | null
  /** GET a JSON resource with a Bearer token. Must not leak the auth on error. */
  /**
   * GET одного JSON-ресурса банка.
   *
   * ⚠ ПРОВАЙДЕР — ОБЯЗАТЕЛЬНЫЙ ПАРАМЕТР (#20), а не удобство. Приор проверяет
   * заголовок взаимодействия FAPI на ЛЮБОМ вызове и делает это ДО тела (#461), поэтому запрос с одним
   * лишь `Authorization` он отвергает. Отказ здесь fail-soft по провайдеру — значит счета Приора
   * просто не появлялись в сверке, и выглядело это как «банк их не отдаёт», а не как наш дефект.
   * Заголовки собирает ВЫЗЫВАЮЩИЙ, и тем же общим билдером, что и путь опроса — здесь их не видно
   * намеренно: этот модуль решает, ЧТО спросить у банка, а не как подписать запрос.
   */
  getJson: (provider: BankProviderId, url: string, accessToken: string) => Promise<unknown>
}

/**
 * Заголовки запроса списка счетов — по банку (#20).
 *
 * ⚠ ЧИСТАЯ функция и живёт ЗДЕСЬ, а не в роуте, ровно потому, что дефект был именно в ней. Роут —
 * `defineEventHandler` поверх живого `$fetch`, и утверждение «для Приора шлём его заголовки» там
 * непроверяемо: мутация «слать один Authorization» проходила зелёной, а на живом портале означала,
 * что счета Приора не появляются в сверке НИКОГДА. Банк проверяет заголовок взаимодействия FAPI на
 * ЛЮБОМ вызове и делает это ДО тела (#461), а отказ здесь fail-soft по провайдеру — то есть симптом
 * читался как «банк их не отдаёт» и указывал не на ту сторону.
 *
 * `interactionId` инъектируется: своей случайности у чистой функции быть не должно.
 */
export function accountsRequestHeaders(
  provider: BankProviderId, accessToken: string, interactionId: string
): Record<string, string> {
  if (provider === 'prior-by') return priorResourceHeaders(accessToken, interactionId)
  return { authorization: `Bearer ${accessToken}` }
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
 * Выбрать, какими токенами спрашивать банк — ПО ОДНОМУ НА КАЖДОЕ ПОДКЛЮЧЕНИЕ (грант).
 *
 * ⚠ Здесь стоял `pickToken` — ОДИН токен на банк, самый свежий по `expiresAt`. Он молча
 * предполагал, что подключение к банку у портала не больше одного, а это неверно: Альфа
 * подключается КЛЮЧОМ API, и у двух юрлиц клиента два разных ключа; у Приора два юрлица — два
 * разных согласия. Хранилище такое держит (ключ `(member_id, provider, account_key)`), опрос тоже
 * (`loadToken` берёт токен ИМЕННО ЭТОГО счёта), а сверка спрашивала банк один раз — то есть
 * видела счета только одного подключения. Счета остальных уходили в `crm-only` — «банк его не
 * отдаёт», с инструкцией подключить банк: экран, заведённый чинить опечатки в реквизитах, на
 * такой конфигурации уверенно указывал не на ту сторону.
 *
 * ⚠ Группируем по ГРАНТУ, а не по строке. Согласие банк выдаёт на НАБОР счетов клиента, и все
 * строки одного гранта живут на общей паре токенов (#23-#25) — спросив по строке, мы задали бы
 * один и тот же вопрос столько раз, сколько у клиента счетов, и сожгли бы лимит банка впустую.
 *
 * ⚠ Пустой `grantId` — «не размечено», а НЕ «общий грант» (подключения до #23-#25). Такая строка
 * считается СВОИМ грантом: склеив их по пустому значению, мы спросили бы банк ОДНИМ токеном за все
 * старые подключения портала — ровно та ошибка, от которой предостерегает `bankTokenStore`.
 *
 * Внутри гранта берём токен с самым долгим сроком, то есть полученный последним. PENDING-строки
 * (#407) годятся намеренно и в самом деле частый случай: админ только что авторизовался в банке и
 * ещё не выбрал счёт — ровно тогда список и нужен.
 */
export function pickGrantTokens(tokens: readonly BankToken[], provider: BankProviderId): BankToken[] {
  const byGrant = new Map<string, BankToken>()
  for (const t of tokens) {
    if (t.provider !== provider) continue
    const grant = (t.grantId ?? '') !== '' ? `g:${t.grantId}` : `r:${t.accountKey}`
    const best = byGrant.get(grant)
    if (!best || t.expiresAt > best.expiresAt) byGrant.set(grant, t)
  }
  return [...byGrant.values()]
}

/**
 * Свести ответы подключений в один результат на банк.
 *
 * ⚠ Счёт, названный ХОТЯ БЫ ОДНИМ подключением, остаётся в списке: положительное знание отказ
 * соседа не отменяет. Дедуп по номеру — два подключения одного клиента могут назвать общий счёт,
 * и вторая строка в матрице выглядела бы как второй счёт.
 *
 * ⚠ `error` берём ПЕРВЫЙ — тексты разных подключений различаются, а показать можно один; сколько
 * их было, говорят `asked`/`failed`, и по ним интерфейс выбирает формулировку. Порядок банков
 * сохраняется (`LISTABLE_PROVIDERS`), иначе экран переставлялся бы от открытия к открытию.
 */
export function mergeGrantAnswers(answers: readonly GrantAnswer[]): BankSideProviderResult[] {
  const out: BankSideProviderResult[] = []
  for (const a of answers) {
    let acc = out.find(p => p.provider === a.provider)
    if (!acc) {
      acc = { provider: a.provider, accounts: [], asked: 0, failed: 0 }
      out.push(acc)
    }
    acc.asked++
    if (a.error) {
      acc.failed++
      if (!acc.error) acc.error = a.error
    }
    for (const one of a.accounts) {
      if (!acc.accounts.some(x => x.number === one.number)) acc.accounts.push(one)
    }
  }
  return out
}

/** Whether the portal has any connection at all to this provider (pending included). */
export function hasConnection(tokens: readonly BankToken[], provider: BankProviderId): boolean {
  return tokens.some(t => t.provider === provider)
}

/** Ответ ОДНОГО подключения (гранта). Провайдер-широкий результат собирает `mergeGrantAnswers`. */
interface GrantAnswer {
  provider: BankProviderId
  accounts: BankSideAccount[]
  error?: string
}

/** Ask ONE bank connection for its account list. Never throws — the failure is the result. */
async function askProvider(
  provider: BankProviderId,
  stored: BankToken,
  deps: BankSideListDeps
): Promise<GrantAnswer> {
  const base = deps.apiBase(provider)
  if (!base) return { provider, accounts: [], error: 'банк не настроен на этом сервере' }
  try {
    // ⚠ ПЕРЕСПРАШИВАЕМ ТОКЕН НА ОТКАЗ БАНКА — ровно как забор выписки (#488). Живой экран
    // 2026-09-09: «Альфа-Банк: банк не ответил (401)» на портале, где сам забор в ту же минуту
    // работал. Разница была только в этом: у забора реактивное переспрашивание уже стояло, а
    // здесь `ensureFresh` решал ПО ЧАСАМ — «свежий по часам, но отвергнутый банком» токен не
    // обновлял никто, и сверка показывала отказ связи там, где протух токен.
    //
    // ⚠ Цена промаха тут не «неудобно»: без стороны банка каждый счёт «моей компании» уходит в
    // состояние «не спрашивали», а выбор счёта кликом (ради которого экран и сделан) пропадает —
    // админ возвращается к ручному вводу 28 знаков.
    let fresh = await deps.ensureFresh(stored)
    const url = accountsUrl(provider, base)
    let raw: unknown
    try {
      raw = await deps.getJson(provider, url, fresh.accessToken)
    } catch (e) {
      // Один раз за провайдера: мёртвый грант иначе жёг бы лимит банка на каждом открытии экрана.
      if (!isBankUnauthorized(e)) throw e
      fresh = await deps.ensureFresh(fresh, { force: true })
      raw = await deps.getJson(provider, url, fresh.accessToken)
    }
    if (provider === 'prior-by') {
      // Prior addresses accounts by an opaque id; the IBAN lives in `identification`. A row with
      // no identification is unusable as a matrix row (nothing to compare against a requisite),
      // so it is dropped rather than shown as an empty line.
      const all = extractAccounts(raw)
      const usable = all
        .map(a => ({ number: (a.identification ?? '').trim(), currency: a.currency, provider }))
        .filter(a => a.number)
      // ⚠ БАНК ОТВЕТИЛ, А ПОКАЗАТЬ НЕЧЕГО — это НЕ то же самое, что «банк молчит» (#20). Молча
      // отбросив все строки, экран выглядел бы как отказ связи, и админ искал бы причину в банке
      // или в подключении, тогда как чинится это на стороне банка — у счёта не заполнен IBAN.
      if (usable.length === 0 && all.length > 0) {
        return {
          provider,
          accounts: [],
          error: `банк вернул ${all.length} счёт(ов) без номера — сверять не с чем`
        }
      }
      return { provider, accounts: usable }
    }
    const accounts = extractAlfaAccounts(raw)
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
  // ⚠ Параллельно теперь по ПОДКЛЮЧЕНИЯМ, а не по банкам, и довод про таймаут от этого только
  // весомее: у портала с тремя подключениями Альфы последовательный обход упёрся бы в потолок
  // nginx втрое быстрее. Худший случай остаётся одним таймаутом при любом их числе.
  const asks = LISTABLE_PROVIDERS.flatMap(provider =>
    pickGrantTokens(tokens, provider).map(stored => askProvider(provider, stored, deps))
  )
  return mergeGrantAnswers(await Promise.all(asks))
}

/** Account keys the portal currently holds a token for, EXCLUDING pending ones — a pending row is
 *  not a connected account (it has no number yet) and would otherwise light up every matrix row as
 *  «подключено». */
export function connectedKeys(tokens: readonly BankToken[]): string[] {
  return tokens.filter(t => !isPendingAccountKey(t.accountKey)).map(t => t.accountKey)
}
