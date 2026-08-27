// Proactive keep-alive for BANK OAuth tokens (#488/#489).
//
// WHY THIS EXISTS. A bank refresh token is renewed only as a SIDE EFFECT of polling the
// statement: cron tick → bank-fetch job → ensureBankToken → refresh. That makes the lifetime of a
// connection depend on a flag that exists for something else entirely (`CRON_REAL_POLL` is about
// not hammering the bank's STATEMENT API), and every reason polling pauses kills the credentials:
// the flag off (its default), Redis down, the account still `~pending`, a quiet weekend.
//
// This is not theoretical. Measured on production (#488): an Alfa connection made at 13:29 UTC was
// dead by 05:00 the next morning — `invalid_grant`, "Persisted access token data not found". Alfa's
// refresh lives ~10 h, and nothing was renewing it. From outside the connection looked healthy:
// a row in the accounts list, `expires_at` describing the ACCESS token, no error anywhere.
//
// The portal-token side of this was solved long ago (`tokenKeepAlive.ts`, #175) and this module is
// its bank-side twin, with three differences that are not cosmetic:
//
//   1. THE CLOCK IS HOURS, NOT MONTHS. Bitrix refresh lives 180 days and a daily scan is plenty;
//      Alfa's lives ~10 hours, so the scan must run hourly and the near-expiry band is measured in
//      hours too. A daily cadence here would be indistinguishable from doing nothing.
//   2. WE MUST FORCE. `ensureBankToken` refreshes when the ACCESS token is near expiry, which is
//      exactly the wrong signal: the access token can be perfectly fresh while the refresh behind
//      it is minutes from death. Hence `{force: true}` — see `runBankKeepAlive`.
//   3. SOME ACCOUNTS CANNOT BE KEPT ALIVE AT ALL. Prior may issue no refresh token; we store an
//      empty string on purpose (`saveBankToken`). Such a connection dies when its access token
//      does and only a human re-authorising in the bank can revive it. Retrying it forever would
//      burn the bank's rate limit on a request that cannot succeed, so it is EXCLUDED from the
//      scan and counted separately — that count is the thing worth showing an admin.

import type { BankProviderId } from '../../app/types/statement'
import { BANK_REFRESH_TTL_MEASURED, BANK_REFRESH_TTL_SEC, consentExpired, EXPIRED_RETRY_INTERVAL_MS, expiredRetryDue, KEEP_ALIVE_BAND, refreshAtAgeMs } from '../../app/utils/bankTokenLifetime'
import type { BankAccountInfo, BankAccountRef, BankToken } from './bankTokenStore'
import { sanitizeForLog } from './logSanitize'
import { portalHash } from './telemetryAttributes'

const HOUR_MS = 3_600_000

// ⚠ Lifetimes and the renew band live in `app/utils/bankTokenLifetime.ts`, not here: the settings
// UI decides what to show an admin from the SAME numbers. Let them drift and you get exactly the
// failure this module was written for — a calm green row on a connection the server already buried.
export { BANK_REFRESH_TTL_MEASURED, BANK_REFRESH_TTL_SEC, consentExpired, EXPIRED_RETRY_INTERVAL_MS, expiredRetryDue, KEEP_ALIVE_BAND, refreshAtAgeMs }

/** Max accounts refreshed per run — bounds the burst against the bank's OAuth endpoint the same
 *  way the portal keep-alive bounds Bitrix. Deliberately generous relative to `bank_tokens`
 *  (tens of rows), so saturation means something is wrong, not that we're busy. */
export const MAX_BANK_KEEP_ALIVE_BATCH = 100

/** Default scan cadence in minutes — half the narrowest band, so one missed tick still leaves a
 *  whole band to catch the token in. */
export const BANK_KEEP_ALIVE_MINUTES = 60

/**
 * The narrowest near-expiry band across configured providers, in ms — the width of the window a
 * token spends between «renew me» and «too late». Alfa's is 2 h (10 h lifetime × the 20 % band).
 *
 * Providers with an unknown lifetime contribute nothing (they are never renewed); with none
 * configured at all the fallback is an hour, which is conservative in the safe direction.
 */
export function narrowestBandMs(): number {
  const bands = (Object.keys(BANK_REFRESH_TTL_SEC) as BankProviderId[])
    .map(p => (BANK_REFRESH_TTL_SEC[p] ?? 0) * 1000 * KEEP_ALIVE_BAND)
    .filter(v => v > 0)
  return bands.length ? Math.min(...bands) : HOUR_MS
}

/** Lower clamp — keeps a typo (`BANK_KEEPALIVE_MINUTES=1`) from turning this into a request loop
 *  against the bank's OAuth endpoint. */
export const MIN_BANK_KEEP_ALIVE_MINUTES = 5

/**
 * Upper clamp — DERIVED, not chosen.
 *
 * ⚠ A fixed number here was a live footgun: 240 min was legal and **wider than Alfa's 2 h band**,
 * so an operator lowering the polling frequency «чтобы не дёргать банк» could step over the window
 * entirely and resurrect exactly the overnight death this module exists to prevent — silently, with
 * every check green. Deriving it from the band makes that unrepresentable: the ceiling is half the
 * narrowest band, so even a maximally-lazy schedule gets two chances inside every window.
 *
 * Consequence worth knowing: shorten a provider's lifetime and this ceiling follows, which may
 * clamp an operator's configured value down. That is the correct direction — the alternative is a
 * setting that is honoured and does not work.
 */
export function maxBankKeepAliveMinutes(): number {
  return Math.max(MIN_BANK_KEEP_ALIVE_MINUTES, Math.floor(narrowestBandMs() / 2 / 60_000))
}

export interface BankKeepAliveSelection {
  /** Accounts to refresh now, oldest first, capped. */
  due: BankAccountRef[]
  /** Connections that CANNOT be kept alive (no stored refresh token) — a human must reconnect. */
  unrefreshable: BankAccountRef[]
  /**
   * Подключения старше НАШЕЙ оценки срока жизни refresh-токена.
   *
   * ⚠ «Cannot succeed» — так здесь было написано, и это утверждение о мире, которого мы не знаем.
   * Срок берётся из документации банка, а не из ответа; строки из этой корзины теперь ещё и
   * попадают в `due` по редкому расписанию, чтобы последнее слово осталось за банком (#489).
   */
  expired: BankAccountRef[]
  /** TRUE only if the cap actually dropped someone. Inferring it from `due.length === cap` cried
   *  wolf on the boundary: exactly-cap accounts due is a full batch handled in full, not a batch
   *  that lost work — and a warning that fires when nothing is wrong is how warnings stop being
   *  read. */
  truncated: boolean
}

/**
 * Split the connected accounts into «renew now» and «cannot be renewed», by age of the last
 * successful connect/refresh (`connectedAt` = the row's `updated_at`, stamped by `saveBankToken` on
 * connect and by `updateBankTokenSecrets` on every refresh — i.e. exactly "when we last held a
 * fresh pair"). Two writers, on purpose: only the OAuth callback may CREATE a row, so a refresh
 * that returns after the account was disconnected cannot resurrect it (#505).
 *
 * Pure over the already-loaded rows: which bank dies when is the fact most likely to be corrected
 * later, and it should be correctable in one table plus one test, not in SQL.
 *
 * ⚠ `~pending` accounts (#407 — connected but the admin hasn't named the account yet) are NOT
 * excluded here, even though the poller skips them. They hold a real token, and the whole point is
 * that the admin can come back tomorrow and finish the setup rather than find a dead connection.
 *
 * ⚠ A provider with a zero lifetime (`manual`, or a bank whose figure is unknown) is skipped, not
 * refreshed constantly: `refreshAtAgeMs` returns 0, and «age ≥ 0» is true for everything.
 *
 * ⚠ THE WINDOW HAS A FLOOR AS WELL AS A CEILING, and the floor is the load-bearing half. A grant
 * the bank has finally rejected (consent revoked, app de-registered) never gets its `updated_at`
 * re-stamped — the failing refresh throws long before `updateBankTokenSecrets`. Without a lower bound such
 * a row stays «due» FOREVER: it sorts oldest-first, monopolises the capped batch, and earns a
 * fresh call to the bank's OAuth endpoint on every single tick, for as long as the row exists.
 * That is a plausible route to a bank deciding we are abusing it — reached with no misconfiguration
 * at all, just by accumulating revoked connections over months. Anything older than the full
 * lifetime is therefore reported as `expired` instead: it cannot succeed, so retrying it is
 * indistinguishable from hammering. (The portal twin bounds its window for exactly this reason,
 * `tokenKeepAlive.ts`.)
 *
 * ⚠ THAT FLOOR APPLIES ONLY TO A MEASURED LIFETIME (`BANK_REFRESH_TTL_MEASURED`). On a guessed one
 * it would be a floor built on a number nobody verified: too short a guess would stop renewing a
 * living connection, and — because the UI refuses to say «expired» on a guess — do it while the
 * badge still reads a reassuring «скоро обновим». Guessed providers therefore keep being retried;
 * the bank is the authority on whether the grant is gone.
 */
export function selectBankAccountsNearExpiry(
  rows: readonly BankAccountInfo[],
  nowMs: number,
  opts: { band?: number, limit?: number } = {}
): BankKeepAliveSelection {
  const limit = opts.limit ?? MAX_BANK_KEEP_ALIVE_BATCH
  const due: BankAccountRef[] = []
  // ⚠ Просроченные ПРОБУЮТСЯ, но собираются ОТДЕЛЬНО и доклеиваются в хвост (#489). Иначе они
  // конкурируют с живыми за места в капнутом батче — а у мёртвой строки шанс на успех заведомо
  // ниже, чем у живой. Прежний тест стерёг ровно это («мёртвая строка не вытесняет живые»), и
  // общий список сломал бы гарантию молча: капнутый батч на портале с десятком мёртвых подключений
  // перестал бы обновлять работающие.
  const expiredRetry: BankAccountRef[] = []
  const unrefreshable: BankAccountRef[] = []
  const expired: BankAccountRef[] = []
  let truncated = false
  /**
   * Гранты, по которым обновление на этом прогоне УЖЕ запланировано (#23).
   *
   * ⚠ Счета одного согласия делят пару токенов, и банк РОТИРУЕТ refresh при каждом обновлении.
   * Взять в батч шесть строк одного гранта — значит шесть раз потратить один refresh: первый обмен
   * удастся, остальные пять пойдут со сгоревшим и получат `invalid_grant`. Внешне это выглядит как
   * «подключение вдруг отвалилось», причём тем вернее, чем больше счетов у клиента. Обновление
   * пишет ротированную пару СРАЗУ ВО ВСЕ строки гранта (`updateBankTokenSecrets`), поэтому одной
   * строки на грант и достаточно.
   *
   * ⚠ Дедуп стоит ТОЛЬКО на действии (обновить), а не на учёте: `expired`/`unrefreshable` — это
   * сводка «сколько подключений в таком состоянии», и схлопывать в ней счета значило бы занижать
   * число строк, которые человеку предстоит чинить.
   */
  const plannedGrants = new Set<string>()
  /** `true` — по этому гранту обновление уже запланировано (пустой грант не группирует). */
  const grantTaken = (row: BankAccountInfo): boolean =>
    row.grantId !== '' && plannedGrants.has(row.grantId)
  const takeGrant = (row: BankAccountInfo): void => {
    if (row.grantId !== '') plannedGrants.add(row.grantId)
  }
  const ordered = [...rows].sort((a, b) => a.connectedAt - b.connectedAt)
  for (const row of ordered) {
    // ⚠ `pollPaused` переносится, но продление НА НЕГО НЕ СМОТРИТ (#576) — и это условие задачи,
    // а не упущение. Пауза останавливает походы за ВЫПИСКОЙ; поставленное на паузу подключение
    // обязано пережить ночь, иначе владельцу счёта пришлось бы заново входить в интернет-банк за
    // тем, что он всего лишь притормозил. Отбор здесь идёт по сроку токена, и только по нему.
    const ref: BankAccountRef = {
      memberId: row.memberId, provider: row.provider, accountKey: row.accountKey, pollPaused: row.pollPaused,
      // ⚠ Грант обязан доехать до `markBankRefreshAttempt`: метка адресуется им, иначе она легла бы
      // на одну строку гранта, и отозванный грант получал бы запрос каждый тик — по разу на счёт.
      grantId: row.grantId
    }
    // ⚠ СОГЛАСИЕ — ПЕРВЫМ, раньше всех оценок по возрасту токена (#503). Это не наша догадка о
    // сроке, а дата, которую выдал сам банк: когда она прошла, обновлять нечего — грант мёртв, и
    // помочь может только вход владельца счёта в интернет-банк. Продолжать слать сюда refresh
    // значило бы тратить лимит банка на запрос, который не может удаться, — то самое, ради чего
    // ниже заведён пол по измеренному сроку, только здесь мы знаем это ТОЧНО.
    if (consentExpired(row, nowMs)) {
      expired.push(ref)
      continue
    }
    if (!row.hasRefresh) {
      unrefreshable.push(ref)
      continue
    }
    const threshold = refreshAtAgeMs(row.provider, opts.band)
    if (threshold <= 0) continue // lifetime unknown/none → don't touch the bank
    const ttlMs = (BANK_REFRESH_TTL_SEC[row.provider] ?? 0) * 1000
    const age = nowMs - row.connectedAt
    if (!Number.isFinite(age)) continue // unparsable timestamp → skip rather than refresh blindly
    // ⚠ «Past its lifetime» is only sayable about a MEASURED lifetime — the same rule the UI
    // follows (`connectionHealth`), and it has to be the same rule or the two disagree in the worst
    // possible direction. Prior's figure is a conservative GUESS; if it is too short, burying the
    // row here stops renewing a connection that is perfectly alive, while the badge keeps saying a
    // calm «скоро обновим» because the UI refuses to declare death on a guess. That is precisely
    // the split this pair of modules exists to prevent, arrived at from the server side.
    //
    // On a guessed lifetime we therefore keep TRYING: the bank is the authority. If the grant is
    // really gone the refresh fails, `hasRefresh`/the error path make it honest by fact, and the
    // floor that protects us from hammering a revoked grant is restored the moment the figure is
    // measured — or replaced by the consent's own `expirationDate` (#503).
    if (age >= ttlMs && BANK_REFRESH_TTL_MEASURED[row.provider]) {
      // ⚠ Старше срока — но ХОРОНИТЬ БЕЗ ВОПРОСА К БАНКУ мы больше не будем (#489). Прежний код
      // клал такую строку в `expired` и не трогал её никогда; живой прогон дал ровно это —
      // `expired=2, refreshed=0, failed=0`, то есть банк не спросили ни разу. Срок — НАША оценка,
      // а правду знает только банк: ошибка в нашу сторону стоит одного неудачного запроса, ошибка
      // в другую — похода владельца счёта в интернет-банк за тем, что не ломалось.
      if (expiredRetryDue(row.lastAttemptAt, nowMs) && !grantTaken(row)) {
        expiredRetry.push(ref)
        takeGrant(row)
      }
      expired.push(ref)
      continue
    }
    if (age < threshold) continue
    // Обновление по гранту уже запланировано — второй счёт того же согласия только сжёг бы refresh.
    if (grantTaken(row)) continue
    if (due.length < limit) {
      due.push(ref)
      takeGrant(row)
    } else truncated = true
  }
  // Живые — первыми, просроченные — в остаток места. Обрезание считается по обоим спискам.
  const room = Math.max(0, limit - due.length)
  const retried = expiredRetry.slice(0, room)
  if (expiredRetry.length > room) truncated = true
  return { due: [...due, ...retried], unrefreshable, expired, truncated }
}

/** Injected side-effects, so the orchestrator unit-tests without a DB or a bank. */
export interface BankKeepAliveDeps {
  now: () => number
  /** Every connected account with freshness (`listAllBankAccountInfo` bound to the store). */
  listAccounts: () => Promise<BankAccountInfo[]>
  /**
   * Отметить попытку обновления (`markBankRefreshAttempt`). Необязательна: движок обязан работать
   * и в тестах, и в скриптах без БД.
   *
   * ⚠ Но без неё редкие повторы для просроченных подключений превращаются в повторы НА КАЖДОМ
   * тике — метка и есть то, что делает «редко» редким. Проводка проверяется отдельным тестом.
   */
  markAttempt?: (ref: BankAccountRef, nowMs: number) => Promise<void>
  /** Load one account's decrypted token, or null if it vanished (disconnected mid-run). */
  getToken: (ref: BankAccountRef) => Promise<BankToken | null>
  /** Refresh + persist under the per-account advisory lock. MUST be called with `{force:true}`. */
  refresh: (token: BankToken) => Promise<BankToken>
  log?: (msg: string) => void
  warn?: (msg: string) => void
}

export interface BankKeepAliveSummary {
  /** Accounts in the near-expiry band this run. */
  selected: number
  /** Successfully rotated to a fresh pair. */
  refreshed: number
  /** Vanished before load, or already rotated by a concurrent poll (idempotent). */
  skipped: number
  /** Refresh rejected by the bank — logged, not fatal; the account needs reconnecting. */
  failed: number
  /** Connections with no stored refresh token at all — cannot be kept alive by anyone. */
  unrefreshable: number
  /** Connections already past their whole lifetime — deliberately NOT retried (see the selector). */
  expired: number
}

/** How many account keys one «needs a human» log line may name. Beyond this the list stops being
 *  read and starts being scrolled past — and on a multi-tenant install the count is the signal,
 *  the names are only there to start the conversation. */
export const MAX_NAMED_IN_LOG = 10

/** «a/1, b/2 … +N ещё» — a bounded, sanitised rendering of a ref list for one log line. */
function nameRefs(refs: readonly BankAccountRef[]): string {
  // ⚠ ПОРТАЛ В ИМЕНИ ОБЯЗАТЕЛЕН, и это находка живого прогона 2026-08-24. Строка выглядела так:
  // `reconnect: alfa-by/BY09…0000, alfa-by/BY09…0000` — один и тот же счёт дважды. Прочитать это
  // как «две строки РАЗНЫХ порталов» было нельзя: первичный ключ `bank_tokens` — тройка
  // (member_id, provider, account_key), поэтому одинаковые имена означают разные `member_id`, но
  // в сообщении их не было. Владелец шёл переподключать «Альфу», не зная, что она подключена
  // дважды с разных порталов.
  //
  // ⚠ Хеш, а не сырой `member_id`: канал продления печатает идентификаторы открыто (#525), но
  // здесь достаточно РАЗЛИЧАТЬ строки, а не называть портал, и хеш это и делает.
  const shown = refs.slice(0, MAX_NAMED_IN_LOG)
    .map(r => `${portalHash(r.memberId)}:${r.provider}/${logSafeKey(r.accountKey)}`).join(', ')
  return refs.length > MAX_NAMED_IN_LOG ? `${shown} (+${refs.length - MAX_NAMED_IN_LOG} more)` : shown
}

/**
 * Счета, подключённые СРАЗУ С НЕСКОЛЬКИХ порталов.
 *
 * ⚠ Это не учёт, а диагноз. Лок обновления берётся по `bankRefreshLockKey(memberId, …)`, то есть
 * ПЕР-ПОРТАЛЬНО: два портала с одним счётом берут РАЗНЫЕ локи и идут в банк параллельно. Альфа
 * ротирует refresh при каждом обновлении, поэтому второй предъявляет уже сожжённый токен. Внутри
 * одного портала эту гонку закрывает лок по гранту (#23); между порталами координации нет и быть
 * не может — это разные согласия.
 *
 * ⚠ Симптом снаружи — «подключение умирает каждую ночь без причины», и переподключение лечит его
 * ровно до следующего обновления. Заметить это по логу было нельзя, пока в нём не было портала.
 */
export function accountsOnManyPortals(rows: readonly BankAccountInfo[]): string[] {
  const byAccount = new Map<string, Set<string>>()
  for (const r of rows) {
    const key = `${r.provider}/${r.accountKey}`
    const set = byAccount.get(key) ?? new Set<string>()
    set.add(r.memberId)
    byAccount.set(key, set)
  }
  return [...byAccount.entries()].filter(([, portals]) => portals.size > 1).map(([key]) => key)
}

/** Account keys can carry an IBAN; clamp + strip before logging (defence-in-depth, PRIVACY §Логи). */
function logSafeKey(v: string): string {
  return v.replace(/[^\w.~:-]/g, '').slice(0, 40)
}

/**
 * Renew every near-expiry bank connection ONCE, isolating per-account failures — one dead grant
 * must not stop the rest, nor crash the cron. Only a failure of the initial listing propagates.
 */
export async function runBankKeepAlive(deps: BankKeepAliveDeps): Promise<BankKeepAliveSummary> {
  const rows = await deps.listAccounts()
  const { due, unrefreshable, expired, truncated } = selectBankAccountsNearExpiry(rows, deps.now())
  const s: BankKeepAliveSummary = {
    selected: due.length, refreshed: 0, skipped: 0, failed: 0,
    unrefreshable: unrefreshable.length, expired: expired.length
  }
  if (truncated) {
    deps.warn?.(`batch saturated (cap ${MAX_BANK_KEEP_ALIVE_BATCH}) — connections were left for the next run and some may expire first`)
  }
  for (const ref of due) {
    try {
      const token = await deps.getToken(ref)
      if (!token) {
        s.skipped++ // disconnected between listing and load
        continue
      }
      const before = token.expiresAt
      // ⚠ Отмечаем ПОПЫТКУ до похода в банк, а не после. Между запросом и ответом до 15 секунд, и
      // если процесс умрёт внутри этого окна, метка всё равно должна остаться: иначе строка,
      // старше своего срока, будет пробоваться на каждом тике — ровно то долбление отозванного
      // гранта, которого мы избегаем. Best-effort: не смогли отметить — не повод отменять попытку.
      await deps.markAttempt?.(ref, deps.now()).catch(() => {})
      const updated = await deps.refresh(token)
      // A bumped ACCESS expiry proves the pair rotated — either by us, or by a poll that won the
      // same advisory lock while we waited. Both outcomes leave a fresh refresh token behind.
      if (updated.expiresAt > before) {
        s.refreshed++
        // ⚠ УСПЕХ НАЗЫВАЕТ СЧЁТ, и до 2026-08-27 не называл — только общий счётчик `refreshed=N`.
        // Отказ счёт называл, успех нет; асимметрия ровно наоборот той, что нужна. Пока подключение
        // было одно, разницы не было. С двумя банками сразу «refreshed=1» не говорит, ЧЕЙ токен
        // продлили, — то есть измерение, ради которого продление и читают, становится негодным.
        //
        // ⚠ Формулировка осторожная («свежая пара после нашей попытки»), потому что счётчик растёт
        // и когда пару успел повернуть ОПРОС, выигравший тот же лок, — это сказано строкой выше и
        // остаётся правдой. Для подключения НА ПАУЗЕ двусмысленности нет: за выпиской к нему никто
        // не ходит, и продлить его мог только крон. На этом и держится ночная проверка #488/#489.
        deps.log?.(`renewed ${ref.provider}/${logSafeKey(ref.accountKey)} — свежая пара после попытки крона`)
      } else {
        s.skipped++
      }
    } catch (e) {
      s.failed++
      // ⚠ Текст ошибки СОЧИНЯЕТ БАНК: `parseTokenResponse` склеивает его из `error_description`
      // ответа. Это ровно тот класс строк, ради которого заведён `sanitizeForLog`, и именно здесь
      // он нужнее всего — эту строку никто не читает в момент появления.
      deps.warn?.(`refresh failed for ${ref.provider}/${logSafeKey(ref.accountKey)}: ${sanitizeForLog((e as { message?: string })?.message ?? String(e))}`)
    }
  }
  // The unrefreshable count is the actionable half of this log line: it names connections that no
  // amount of retrying will fix, and that nobody is otherwise told about.
  if (unrefreshable.length > 0) {
    deps.warn?.(`${unrefreshable.length} connection(s) have NO refresh token — they die with their access token and need reconnecting: ${nameRefs(unrefreshable)}`)
  }
  // ⚠ Формулировка изменена вместе с поведением (#489). Прежняя говорила «NOT retried — reconnect
  // required», и это было ПРАВДОЙ о коде и НЕПРАВДОЙ о мире: срок — наша оценка, а решает банк.
  // Теперь такие подключения пробуются редко (`EXPIRED_RETRY_INTERVAL_MS`), и сообщение обязано
  // это отражать — иначе владелец пойдёт переподключать то, что вот-вот воскреснет само.
  if (expired.length > 0) {
    deps.warn?.(`${expired.length} connection(s) past their assumed refresh lifetime — retried rarely, the bank has the final say; if the retry keeps failing, reconnect: ${nameRefs(expired)}`)
  }
  // ⚠ Отдельной строкой и ГРОМЧЕ остальных: пока счёт подключён с двух порталов, переподключение
  // лечит симптом до следующего обновления, и владелец ходит в интернет-банк по кругу.
  const shared = accountsOnManyPortals(rows)
  if (shared.length > 0) {
    deps.warn?.(`${shared.length} account(s) connected from MORE THAN ONE portal: ${shared.map(logSafeKey).join(', ')} — `
      + `refresh is locked per portal, so they refresh in parallel and burn each other's rotated token. `
      + `Reconnecting only helps until the next refresh: disconnect the account on the portal that should not have it.`)
  }
  // ⚠ `total` — по факту потерянных дней (#488). Сводка из одних нулей читалась одинаково в двух
  // РАЗНЫХ мирах: «подключений нет вовсе» и «все подключения свежие, обновлять нечего». Первое —
  // поломка настройки, второе — норма, и различить их по строке было нельзя.
  deps.log?.(`total=${rows.length} selected=${s.selected} refreshed=${s.refreshed} skipped=${s.skipped} failed=${s.failed} unrefreshable=${s.unrefreshable} expired=${s.expired}`)
  return s
}

/** Scan cadence in ms from a minutes setting, clamped into [MIN, derived max]. Pure. */
export function bankKeepAliveIntervalMs(minutes: number): number {
  const m = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : BANK_KEEP_ALIVE_MINUTES
  return Math.min(maxBankKeepAliveMinutes(), Math.max(MIN_BANK_KEEP_ALIVE_MINUTES, m)) * 60_000
}
