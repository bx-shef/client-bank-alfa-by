// Служебный пользователь приложения (событие ONAPPUSERREADY): сверка и запись его id.
//
// Зачем он нам: элементы смарт-процессов «Платежи» и «Распределения» ставятся на него, а не на
// того, кто установил приложение (решение владельца 2026-09-29). Служебный пользователь — это
// техническая учётная запись с именем приложения; узнать его id можно ТОЛЬКО из этого события,
// отдельного метода REST у портала нет.
//
// ⚠ ПОЧЕМУ СВЕРКА ОТКЛАДЫВАЕТСЯ. Событие подлинно, только если его токен приложения совпал с
// сохранённым при установке, — а установку записывает воркер ПОСЛЕ того, как роут события установки
// сходил на сервер авторизации Битрикс24 (#162). Оба события портал шлёт по завершении установки
// разом, так что это событие легко приходит раньше, чем установка записана. Отказать в таком случае
// нельзя — онлайн-события портал не повторяет, и служебный пользователь был бы потерян навсегда.
// Ждать прямо в роуте тоже нельзя: если портал шлёт события по одному, он ждал бы нашего ответа, а
// мы — его следующего события. Поэтому роут кладёт в очередь ОТПЕЧАТОК токена, а воркер сверяет
// его, когда установка записана, — с повторами по нарастающей (`SYSTEM_USER_RETRY_OPTS`).
//
// ⚠ Отпечаток, а не сам токен: токен приложения — секрет, которым проверяется удаление приложения,
// и лежать открытым текстом в Redis ему незачем. sha256 высокоэнтропийного токена не обратить.

import { createHash } from 'node:crypto'
import { safeEqual } from '../../app/utils/b24Events'
import type { RestCall } from './companyLookup'
import { tokenOwnerId } from './portalTokenOwner'
import { useServerLogger } from './serverLogger'

const log = useServerLogger('b24-events')

/** Отпечаток токена приложения — то, что едет в очередь вместо самого токена. */
export function applicationTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Чем кончилась обработка события.
 *  - `saved` — id записан;
 *  - `gone` — портала у нас уже нет (удалили, пока событие шло), записывать некуда;
 *  - `mismatch` — токен не совпал с сохранённым при установке: событие не от портала, отброшено;
 *  - `expired` — установка так и не записалась за все попытки; сверить не с чем, id не записан.
 */
export type SystemUserOutcome = 'saved' | 'gone' | 'mismatch' | 'expired'

/** Заявка из очереди. `appTokenHash` есть ⇒ роут сверить не смог, сверяем здесь. */
export interface SystemUserClaimJob {
  memberId: string
  userId: number
  appTokenHash?: string
}

export interface SystemUserDeps {
  /** Токен приложения, сохранённый при установке; `''` — установка ещё (или уже) не записана. */
  loadApplicationToken: (memberId: string) => Promise<string>
  /** UPDATE-only запись id; `false` — строки портала нет. */
  setSystemUserId: (memberId: string, userId: number) => Promise<boolean>
}

/**
 * Сколько НЕСВЕРЕННЫХ заявок о служебном пользователе в минуту пускаем в очередь — на весь сервис.
 *
 * ⚠ Отложенная сверка — ЕДИНСТВЕННЫЙ путь, по которому в очередь попадает событие, чья подлинность
 * ещё не проверена: у портала, установка которого не записана, сверять не с чем. Без потолка поток
 * подделок с выдуманными порталами стал бы потоком задач в той самой очереди, что несёт установки, —
 * с одним исполнителем по порядку, то есть настоящая установка ждала бы, пока он разберёт подделки.
 * Настоящих заявок — по одной на установку; тридцать в минуту на весь сервис — с запасом.
 *
 * ⚠ Сверх потолка заявка отбрасывается — мягко, как любая потеря этого события: элементы остаются
 * на установившем. Под атакой так может потеряться и настоящая — это цена, и она названа.
 */
export const MAX_DEFERRED_CLAIMS_PER_MINUTE = 30

/**
 * Пустить ли ещё одну несверенную заявку (`true`) — счётчик в Redis по минутному окну.
 *
 * ⚠ Предупреждение в лог — ОДНО на минуту, на первой отброшенной: строка на каждую отброшенную
 * подделку превратила бы потолок против потока задач в поток строк лога.
 */
export async function admitDeferredClaim(
  incr: (key: string, ttlSec: number) => Promise<number>,
  nowMs: number
): Promise<boolean> {
  const count = await incr(`sysuser-deferred:${Math.floor(nowMs / 60_000)}`, 120)
  if (count === MAX_DEFERRED_CLAIMS_PER_MINUTE + 1) {
    log.warning(`несверенных заявок о служебном пользователе больше ${MAX_DEFERRED_CLAIMS_PER_MINUTE} за минуту — лишние отброшены (похоже на поток подделок; настоящих — по одной на установку)`)
  }
  return count <= MAX_DEFERRED_CLAIMS_PER_MINUTE
}

/** Установка ещё не записана — повторить позже. Бросается ТОЛЬКО не на последней попытке. */
export class SystemUserPendingError extends Error {
  constructor(memberId: string) {
    super(`ONAPPUSERREADY: установка портала ${memberId} ещё не записана — повторим`)
    this.name = 'SystemUserPendingError'
  }
}

/**
 * Сверить (если роут не смог) и записать id служебного пользователя.
 *
 * ⚠ На ПОСЛЕДНЕЙ попытке «установка не записана» — это `expired`, а не исключение. Исчерпанная
 * задача попала бы в счёт падений очереди, а три таких за час будят владельца «очередь падает»
 * (`queueAlert.ts`). Здесь же не наша поломка: установка не дошла (её отверг сервер авторизации) или
 * событие подделано. Последствие у обоих одно и то же и мягкое — элементы останутся на установившем.
 */
export async function applySystemUserClaim(
  claim: SystemUserClaimJob,
  deps: SystemUserDeps,
  opts: { finalAttempt: boolean }
): Promise<SystemUserOutcome> {
  if (claim.appTokenHash !== undefined) {
    const stored = await deps.loadApplicationToken(claim.memberId)
    if (!stored) {
      if (!opts.finalAttempt) throw new SystemUserPendingError(claim.memberId)
      log.warning(`portal ${claim.memberId}: служебный пользователь НЕ записан — установка так и не записалась, сверить событие не с чем; элементы останутся на установившем`)
      return 'expired'
    }
    // ⚠ Сравнение без раннего выхода: по времени ответа нельзя угадывать отпечаток по символу.
    if (!safeEqual(applicationTokenHash(stored), claim.appTokenHash)) {
      log.warning(`portal ${claim.memberId}: событие о служебном пользователе НЕ прошло сверку токена приложения — отброшено`)
      return 'mismatch'
    }
  }
  if (!(await deps.setSystemUserId(claim.memberId, claim.userId))) {
    log.info(`portal ${claim.memberId}: служебный пользователь не записан — портала у нас уже нет`)
    return 'gone'
  }
  log.info(`portal ${claim.memberId}: служебный пользователь записан (id ${claim.userId}) — на него пойдут новые элементы смарт-процессов`)
  return 'saved'
}

/**
 * Ответственный НОВОГО элемента смарт-процесса: служебный пользователь приложения, а где его нет —
 * установивший, то есть владелец сохранённого токена (решение владельца 2026-09-29: «там где нет
 * такой поддержки — пусть будет везде человек, который всё установил»).
 *
 * «Нет» — это ноль в нашей колонке: локальному приложению событие не приходит никогда, портал,
 * установленный раньше этой правки, его ещё не присылал, старая коробка его не знает.
 *
 * ⚠ Отказ `profile` на запасном пути ПРОБРАСЫВАЕТСЯ (см. `tokenOwnerId`): запись элемента упадёт и
 * будет повторена, а не создаст элемент «на кого придётся» — ответственный ставится только при
 * создании, и неверный остался бы навсегда.
 */
export async function elementResponsibleId(
  memberId: string,
  call: RestCall,
  deps: { loadSystemUserId: (memberId: string) => Promise<number | null> }
): Promise<number> {
  return (await deps.loadSystemUserId(memberId))
    ?? tokenOwnerId(call, memberId, 'assignedById of a smart-process element')
}
