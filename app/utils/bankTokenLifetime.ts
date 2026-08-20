// How long a bank connection lives, and how to say that to a human (#488).
//
// Lives in `app/utils` on purpose: the SAME numbers decide two different things, and they must not
// drift apart. The server uses them to pick whom to renew (`bankTokenKeepAlive.ts`); the settings
// UI uses them to tell an admin whether a connection is still good. A UI that computed «свежее» by
// its own rule would happily show green on a connection the server had already given up on — which
// is precisely the failure this issue is about, only moved one screen over.

import type { BankProviderId } from '~/types/statement'
import { isPendingAccountKey } from '~/utils/bankAccountKey'
import { ALFA_REFRESH_TOKEN_TTL_SEC } from '~/utils/alfaOauth'

/**
 * Refresh-token lifetime per provider, in SECONDS.
 *
 * ⚠ `alfa-by` is the bank's documented figure AND confirmed live (#488): a connection made at 13:29
 * was rejected by 05:00 the next morning. `prior-by` is a deliberate UNDER-estimate, not a
 * measurement — the bank does not document it and we have not observed an expiry. Guessing low
 * costs a couple of extra token calls a day; guessing high costs a dead connection that only the
 * account owner can revive by logging into their internet bank.
 *
 * `manual` has no online token at all (file upload) and never reaches `bank_tokens`; it is present
 * so the map stays exhaustive over `BankProviderId` — a new bank will not compile until someone
 * states how long its refresh lives.
 */
export const BANK_REFRESH_TTL_SEC: Record<BankProviderId, number> = {
  'alfa-by': ALFA_REFRESH_TOKEN_TTL_SEC,
  'prior-by': 12 * 3600,
  'manual': 0
}

/**
 * Which of those numbers we actually KNOW.
 *
 * ⚠ This distinction is not pedantry — the same number does two jobs with very different costs.
 * As a refresh threshold, being wrong costs a spare token call. As the badge «подключение
 * истекло», it costs a person a trip into their internet bank to re-authorise something that was
 * never broken. An assumed lifetime is good enough for the first job and not for the second, so
 * the UI refuses to declare a connection dead on a guess (see `connectionHealth`).
 *
 * `alfa-by` is measured: a connection made at 13:29 was rejected by 05:00 the next morning (#488),
 * matching the bank's documented ~10 h. Prior's figure is a conservative guess — the bank does not
 * publish it, and the honest fix is to store the consent's own `expirationDate`, which Prior DOES
 * return when the consent is created (#503).
 */
export const BANK_REFRESH_TTL_MEASURED: Record<BankProviderId, boolean> = {
  'alfa-by': true,
  'prior-by': false,
  'manual': false
}

/**
 * Истекло ли СОГЛАСИЕ банка. `0`/отсутствует/не число ⇒ `false` — «мы не знаем», а не «истекло».
 *
 * ⚠ Умолчание тут решает исход для всех подключений, у которых даты нет (Альфа вовсе, и любой
 * Приор, подключённый до #503). «Не знаем ⇒ истекло» одним махом объявило бы их мёртвыми и послало
 * бы людей в интернет-банк за тем, что работает.
 */
export function consentExpired(c: ConnectionLike, nowMs: number): boolean {
  const at = c.consentExpiresAt
  return typeof at === 'number' && Number.isFinite(at) && at > 0 && nowMs >= at
}

/**
 * За сколько до конца согласия предупреждать администратора.
 *
 * ⚠ Неделя, а не день: продлевает согласие НЕ администратор, а владелец счёта, заходя в
 * интернет-банк, — и это не то, что организуют за вечер. Предупреждение за день превратилось бы в
 * уведомление об уже случившемся простое.
 */
export const CONSENT_WARN_DAYS = 7

/** Скоро ли истекает согласие (и ещё не истекло). Без даты — `false`. */
export function consentExpiringSoon(c: ConnectionLike, nowMs: number, days = CONSENT_WARN_DAYS): boolean {
  const at = c.consentExpiresAt
  if (!(typeof at === 'number' && Number.isFinite(at) && at > 0)) return false
  return nowMs < at && at - nowMs <= days * 86_400_000
}

/** Renew once the token is within this fraction of its life from expiry (0.2 of Alfa's 10 h = 2 h). */
export const KEEP_ALIVE_BAND = 0.5

/**
 * Как часто ПРОБОВАТЬ подключение, которое мы уже сочли мёртвым по своим часам (#489).
 *
 * ⚠ Раньше такого числа не было, потому что не было и самой попытки: строка старше срока уходила в
 * корзину `expired` и не обновлялась НИКОГДА. Живой прогон показал, чем это кончается —
 * `expired=2, refreshed=0, failed=0`: банк не спросили ни разу, подключение похоронили мы сами.
 *
 * ⚠ Срок — НАШЕ представление о жизни токена, а банк — единственный, кто знает правду. Ошибка в
 * нашу сторону стоит одного HTTP-запроса, который не удастся; ошибка в другую стоит владельцу
 * счёта похода в интернет-банк за тем, что и не ломалось. Асимметрия очевидна, поэтому пробуем —
 * но редко, чтобы не долбить действительно отозванный грант.
 */
export const EXPIRED_RETRY_INTERVAL_MS = 6 * 3600 * 1000

/**
 * Пора ли дать ПОСЛЕДНИЙ шанс подключению, которое старше своего срока.
 *
 * `lastAttemptAt === 0` (не пробовали ни разу) ⇒ пробуем немедленно: это ровно тот случай, когда
 * подключение пережило простой сервиса и было объявлено мёртвым, ни разу не будучи спрошенным.
 */
export function expiredRetryDue(lastAttemptAt: number, nowMs: number, intervalMs = EXPIRED_RETRY_INTERVAL_MS): boolean {
  if (!Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0) return true
  return nowMs - lastAttemptAt >= intervalMs
}

/**
 * Age (ms) at which a provider's token should be renewed: lifetime minus the band. 0 ⇒ unknown.
 *
 * ⚠ Полоса — 0.5, а не 0.2, и это не вкусовщина. При 0.2 окно, в котором обновление вообще
 * возможно, для Альфы составляло 8..10 часов — ДВА часовых тика. Любой перерыв длиннее двух часов
 * ровно в этом окне (деплой, простой Redis, остановка крон-инстанса) означал, что подключение
 * перевалит за срок и будет похоронено. Один пропущенный тик не должен стоить владельцу счёта
 * похода в банк, поэтому обновляем с половины срока: окно 5..10 часов, пять шансов вместо двух,
 * и каждый успех сдвигает следующее окно на пять часов вперёд.
 *
 * ⚠ Цена — примерно вдвое больше обращений за токеном. На фоне лимита банка (80/мин) и одного
 * счёта на прогон это неизмеримо мало.
 */
export function refreshAtAgeMs(provider: BankProviderId, band = KEEP_ALIVE_BAND): number {
  const ttlMs = (BANK_REFRESH_TTL_SEC[provider] ?? 0) * 1000
  return ttlMs * (1 - band)
}

/**
 * What we can honestly say about one connection:
 *   `ok`         — renewable and comfortably fresh;
 *   `due`        — past the renew threshold but still within its lifetime (keep-alive's job);
 *   `expired`    — older than the whole lifetime, the refresh token is almost certainly gone;
 *   `no-refresh` — none was ever stored, nothing can renew this, a human must re-authorise;
 *   `unknown`    — lifetime unknown for this provider (or a nonsense clock) → say nothing.
 */
export type BankConnectionHealth = 'ok' | 'due' | 'expired' | 'no-refresh' | 'unknown'

/**
 * Состояния, которые НЕ рассосутся сами: их лечит человек, зайдя в интернет-банк.
 *
 * ⚠ Единственный источник. Список успел разойтись по трём файлам (тревога в Telegram, сводка для
 * оператора, экран готовности портала), и это ровно тот дрейф, о котором предупреждает шапка
 * модуля: поправят в одном месте — три экрана начнут расходиться молча. `due` сюда не входит
 * намеренно («мы уже обновляем сами»), `unknown` — тоже («срок неизвестен», хоронить по догадке
 * нельзя).
 */
export const NEEDS_HUMAN_HEALTH: readonly BankConnectionHealth[] = ['expired', 'no-refresh']

/** Требует ли это состояние действия человека. */
export function needsHumanHealth(h: BankConnectionHealth): boolean {
  return NEEDS_HUMAN_HEALTH.includes(h)
}

export interface ConnectionLike {
  provider: BankProviderId
  /** Epoch ms of the last successful connect/refresh. */
  connectedAt: number
  /** Whether a refresh token is stored at all. */
  hasRefresh: boolean
  /**
   * Epoch ms when the BANK'S CONSENT expires (#503). Prior returns it; 0/absent — unknown.
   *
   * ⚠ A different clock from the refresh token, and the stricter one. Prior's consent lives ~90
   * days, and once it lapses no token refresh helps at all — only the account owner logging into
   * their internet bank does. Refresh lifetime is our estimate; this date is the bank's own answer,
   * which is why it may declare a connection dead where a guess may not.
   */
  consentExpiresAt?: number
}

/**
 * Classify one connection by the age of its last known-good token pair.
 *
 * ⚠ Deliberately NOT based on `expiresAt`: that field describes the ACCESS token, which is the
 * field the old UI showed and the reason a dead connection looked healthy — access can be minutes
 * old while the refresh behind it is already gone. Age of the pair is the only signal that tracks
 * the thing that actually dies.
 */
export function connectionHealth(c: ConnectionLike, nowMs: number): BankConnectionHealth {
  // ⚠ СОГЛАСИЕ ПРОВЕРЯЕТСЯ ПЕРВЫМ и перекрывает всё остальное (#503). Это не наша оценка, а ответ
  // банка: срок вышел — обновлять нечего, никакой refresh не поможет, нужен вход владельца счёта в
  // интернет-банк. Свежий refresh-токен при истёкшем согласии выглядит здоровым и не работает —
  // ровно тот разрыв между «выглядит» и «работает», ради которого написан весь модуль.
  if (consentExpired(c, nowMs)) return 'expired'
  if (!c.hasRefresh) return 'no-refresh'
  const ttlMs = (BANK_REFRESH_TTL_SEC[c.provider] ?? 0) * 1000
  if (ttlMs <= 0) return 'unknown'
  const age = nowMs - c.connectedAt
  if (!Number.isFinite(age) || age < 0) return 'unknown'
  // ⚠ «Истекло» произносим ТОЛЬКО про измеренный срок. На угаданном это была бы ложная тревога,
  // которая стоит человеку похода в интернет-банк за тем, что не ломалось. Для угаданного срока
  // потолок остаётся «пора обновить» — приложение попробует само, и если банк откажет, состояние
  // станет честным по факту, а не по нашей догадке.
  if (age >= ttlMs) return BANK_REFRESH_TTL_MEASURED[c.provider] ? 'expired' : 'due'
  if (age >= refreshAtAgeMs(c.provider)) return 'due'
  return 'ok'
}

/**
 * Badge text + colour + hint per health state.
 *
 * `as const` is load-bearing, not decoration: `B24Badge`'s `color` prop is a literal union, so a
 * widened `string` here fails to compile at the call site — which is the right place for the
 * compiler to object if someone invents a colour the design system doesn't have.
 *
 * ⚠ Colours carry MEANING and it is not decorative: `alert` says «действуй сейчас, импорт стоит»,
 * `warning` says «однажды встанет», `accent` says «мы уже это делаем, тебя не касается». Wording
 * follows the same split — the `due` hint ends with «Действий не требуется» on purpose, because a
 * badge that looks like a problem and isn't one is how people learn to ignore badges.
 */
const HEALTH_BADGE = {
  'no-refresh': {
    label: 'нужно переподключить',
    color: 'air-primary-warning',
    hint: 'Банк не выдал токен обновления, поэтому продлить подключение нечем. Когда истечёт текущий доступ, импорт остановится — переподключите счёт.'
  },
  'expired': {
    label: 'подключение истекло',
    color: 'air-primary-alert',
    hint: 'Срок обновления вышел — банк, скорее всего, уже не примет наш токен. Переподключите счёт: потребуется вход владельца счёта в интернет-банк.'
  },
  'due': {
    label: 'скоро обновим',
    color: 'air-secondary-accent',
    hint: 'Подключение в зоне обновления — приложение продлит его само на ближайшем цикле. Действий не требуется.'
  }
} as const

/**
 * Потолок возраста БРОШЕННОГО ожидающего подключения (#485).
 *
 * ⚠ Нужен как раз потому, что «мертво» доказуемо не всегда: у Приора срок refresh — догадка
 * (`BANK_REFRESH_TTL_MEASURED`), а согласия может не быть вовсе. Без потолка такие строки жили бы
 * вечно — а именно они и копятся: каждое повторное подключение заводит НОВУЮ строку (nonce всякий
 * раз другой, иначе два параллельных connect'а затирали бы друг друга).
 *
 * ⚠ Двое суток, а не часы: подключение начинает админ, а завершает его владелец счёта, и «зашёл в
 * банк вечером, вписал номер утром» — обычный сценарий, а не небрежность. Снести такую строку
 * раньше значит заставить человека проходить банк заново.
 */
export const PENDING_MAX_AGE_DAYS = 2

/**
 * Пора ли удалить ожидающее подключение: оно уже не может стать рабочим.
 *
 * Два основания, и второе не заменяет первое:
 *  • состояние `expired` — это ДОКАЗАННАЯ смерть (истекло согласие банка либо вышел ИЗМЕРЕННЫЙ срок
 *    refresh). Держать такую строку незачем ни минуты: выбор счёта на ней создал бы подключение,
 *    которое отвалится на первом же обращении к банку;
 *  • возраст сверх потолка — для случаев, где смерть не доказуема (`unknown`, `due`, `no-refresh`).
 *
 * ⚠ Только `~pending:`. Живое подключение свипу не подлежит никогда: у него есть выбранный счёт, по
 * нему идёт опрос, и «состарившийся» токен там чинит keep-alive, а не удаление.
 */
export function abandonedPending(
  c: ConnectionLike & { accountKey: string },
  nowMs: number,
  maxAgeDays = PENDING_MAX_AGE_DAYS
): boolean {
  // ⚠ Через общий хелпер, а не литералом: префикс объявлен в `bankAccountKey.ts`, и ВСЕ прочие
  // потребители зовут именно его. Вторая копия строки разошлась бы молча — и именно здесь, в
  // единственном гейте, который отделяет удаляемое от рабочего подключения.
  if (!isPendingAccountKey(c.accountKey)) return false
  if (connectionHealth(c, nowMs) === 'expired') return true
  const age = nowMs - c.connectedAt
  // ⚠ Пол встроен ЗДЕСЬ, а не только в разбор env. Функция экспортирована и удаляет данные доступа:
  // полагаться на то, что единственный сегодняшний вызывающий передаёт уже клампленное значение, —
  // мина для будущего рефакторинга. С `maxAgeDays = 0` она сносила бы подключение возрастом в
  // миллисекунду (проверено ревью тестировщика прямым вызовом).
  const floorDays = Math.max(1, maxAgeDays)
  return Number.isFinite(age) && age >= floorDays * 86_400_000
}

/** Badge for a health state, or `null` when there is nothing worth saying.
 *  `ok` and `unknown` return null on purpose: a badge on every healthy row is noise that trains
 *  people to stop reading badges, and «подключён N назад» already sits right below. */
export function connectionHealthBadge(h: BankConnectionHealth): typeof HEALTH_BADGE[keyof typeof HEALTH_BADGE] | null {
  return h === 'ok' || h === 'unknown' ? null : HEALTH_BADGE[h]
}
