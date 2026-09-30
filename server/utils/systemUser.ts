// Служебный пользователь приложения (событие ONAPPUSERREADY): сверка и запись его id, выбор
// ответственного для новых элементов смарт-процессов.
//
// Зачем он нам: элементы смарт-процессов «Платежи» и «Распределения» ставятся на него, а не на
// того, кто установил приложение (решение владельца 2026-09-29). Служебный пользователь — это
// техническая учётная запись с именем приложения; узнать его id можно ТОЛЬКО из этого события,
// отдельного метода REST у портала нет.
//
// ⚠ ПОЧЕМУ СВЕРКА ИДЁТ В ВОРКЕРЕ. Событие подлинно, только если его токен приложения совпал с
// сохранённым при установке, — а установку записывает воркер ПОСЛЕ того, как роут события установки
// сходил на сервер авторизации Битрикс24 (#162). По документации оба события вызываются при
// завершении установки; порядок доставки не документирован и не замерен, так что это событие может
// прийти раньше, чем установка записана. Отказать в таком случае
// нельзя — онлайн-события портал не повторяет, и служебный пользователь был бы потерян навсегда.
// Ждать прямо в роуте тоже нельзя: если портал шлёт события по одному, он ждал бы нашего ответа, а
// мы — его следующего события. Поэтому роут кладёт в очередь ОТПЕЧАТОК токена, а воркер сверяет его
// в момент записи — с повторами по нарастающей (`SYSTEM_USER_RETRY_OPTS`).
//
// ⚠ Сверка в воркере — ВСЕГДА, даже если роут уже сверил: между ними могла пройти деинсталляция с
// мгновенной переустановкой, и верить нужно токену, который лежит в базе в момент записи, а не тому,
// что лежал там при приёме события (находка ревью).
//
// ⚠ Отпечаток, а не сам токен (`appTokenHash.ts`): токен приложения — секрет, которым проверяется
// удаление приложения, и лежать открытым текстом в Redis ему незачем.

import { safeEqual } from '../../app/utils/b24Events'
import { applicationTokenHash } from './appTokenHash'
import type { ResponsibleResolver } from './distributionLedgerWrite'
import { portalErrorCode, portalErrorMethod } from './portalError'
import { useServerLogger } from './serverLogger'
import { portalHash } from './telemetryAttributes'

const log = useServerLogger('b24-events')

/**
 * Чем кончилась обработка события.
 *  - `saved` — id записан;
 *  - `gone` — портала у нас уже нет (удалили, пока событие шло), записывать некуда;
 *  - `mismatch` — токен не совпал с сохранённым при установке: событие не от портала, отброшено;
 *  - `expired` — установка так и не записалась за все попытки; сверить не с чем, id не записан.
 */
export type SystemUserOutcome = 'saved' | 'gone' | 'mismatch' | 'expired'

/** Заявка из очереди: кого записать и отпечаток токена, которым её сверить. */
export interface SystemUserClaimJob {
  memberId: string
  userId: number
  appTokenHash: string
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
 * ⚠ Заявка, которую роут не смог сверить, — ЕДИНСТВЕННЫЙ путь, по которому в очередь попадает
 * событие неподтверждённой подлинности: у портала, установка которого не записана, сверять не с чем.
 * Без потолка поток подделок с выдуманными порталами стал бы потоком задач в той самой очереди, что
 * несёт установки, — с одним исполнителем по порядку, то есть настоящая установка ждала бы, пока он
 * разберёт подделки. Настоящих заявок — по одной на установку; тридцать в минуту на весь сервис — с
 * запасом.
 *
 * ⚠ Сверх потолка заявка отбрасывается — мягко, как любая потеря этого события: элементы остаются
 * на установившем. Под атакой так может потеряться и настоящая — это цена, и она названа.
 */
export const MAX_DEFERRED_CLAIMS_PER_MINUTE = 30

/** Сколько ждём счётчик потолка, прежде чем счесть Redis недоступным. */
export const ADMIT_DEADLINE_MS = 1500

/**
 * Пустить ли ещё одну несверенную заявку (`true`) — счётчик в Redis по минутному окну.
 *
 * ⚠ Предупреждение в лог — ОДНО на минуту, на первой отброшенной: строка на каждую отброшенную
 * подделку превратила бы потолок против потока задач в поток строк лога.
 */
export async function admitDeferredClaim(
  incr: (key: string, ttlSec: number) => Promise<number>,
  nowMs: number,
  deadlineMs = ADMIT_DEADLINE_MS
): Promise<boolean> {
  // ⚠ Дедлайн обязателен: при недоступном, но настроенном Redis клиент очереди не отвечает ошибкой, а
  // ЖДЁТ (офлайн-очередь ioredis, `maxRetriesPerRequest: null`) — и непроверенный запрос висел бы до
  // таймаута nginx, копясь сотнями. Тот же приём, что у `pingRedis` (находка ревью #783).
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('sysuser cap: redis deadline')), deadlineMs)
  })
  const counted = incr(`sysuser-deferred:${Math.floor(nowMs / 60_000)}`, 120)
  counted.catch(() => {}) // поздний отказ после дедлайна — не необработанное исключение
  let count: number
  try {
    count = await Promise.race([counted, deadline])
  } finally {
    clearTimeout(timer)
  }
  if (count === MAX_DEFERRED_CLAIMS_PER_MINUTE + 1) {
    log.warning(`несверенных заявок о служебном пользователе больше ${MAX_DEFERRED_CLAIMS_PER_MINUTE} за минуту — лишние отброшены (похоже на поток подделок; настоящих — по одной на установку)`)
  }
  return count <= MAX_DEFERRED_CLAIMS_PER_MINUTE
}

/**
 * Установка ещё не записана — повторить позже. Бросается ТОЛЬКО не на последней попытке.
 *
 * ⚠ В тексте — ХЕШ портала, не `member_id`: заявка ещё не проверена, а текст ошибки печатает
 * наблюдатель падений задач (`workerObservability.ts`) как есть.
 */
export class SystemUserPendingError extends Error {
  constructor(memberId: string) {
    super(`ONAPPUSERREADY: установка портала ${portalHash(memberId)} ещё не записана — повторим`)
    this.name = 'SystemUserPendingError'
  }
}

/**
 * Сверить заявку с токеном, который лежит в базе СЕЙЧАС, и записать id служебного пользователя.
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
  const stored = await deps.loadApplicationToken(claim.memberId)
  if (!stored) {
    if (!opts.finalAttempt) throw new SystemUserPendingError(claim.memberId)
    // Хеш, а не `member_id`: заявка так и осталась непроверенной (как и ниже, при несовпадении).
    // «Нет строки» бывает двумя путями — установка так и не записалась либо портал удалили, пока
    // заявка ждала повтора, — и различить их здесь нечем, поэтому названы оба.
    log.warning(`portal ${portalHash(claim.memberId)}: служебный пользователь НЕ записан — установки нет (не записалась или портал успели удалить), сверить событие не с чем; элементы останутся на установившем`)
    return 'expired'
  }
  // ⚠ Сравнение без раннего выхода: по времени ответа нельзя угадывать отпечаток по символу.
  if (!safeEqual(applicationTokenHash(stored), claim.appTokenHash)) {
    log.warning(`portal ${portalHash(claim.memberId)}: событие о служебном пользователе НЕ прошло сверку токена приложения — отброшено`)
    return 'mismatch'
  }
  if (!(await deps.setSystemUserId(claim.memberId, claim.userId))) {
    log.info(`portal ${claim.memberId}: служебный пользователь не записан — портала у нас уже нет`)
    return 'gone'
  }
  log.info(`portal ${claim.memberId}: служебный пользователь записан (id ${claim.userId}) — на него пойдут новые элементы смарт-процессов`)
  return 'saved'
}

/**
 * Коды, которыми `crm.item.add` по документации отвечает на неверное значение поля
 * (`CRM_FIELD_ERROR_VALUE_NOT_VALID`) и на запрет (`ACCESS_DENIED`). Только они и значат «портал не
 * принял ответственного», и только если отказал сам вызов создания элемента — тот, что нёс поле.
 *
 * ⚠ Список РАЗРЕШЁННЫХ, а не исключённых кодов (находка ревью #783). Прежний вариант перечислял
 * «временные» коды, и мимо него проходило всё, что SDK отдаёт на сбой транспорта со своим кодом —
 * `NETWORK_ERROR`, `REQUEST_TIMEOUT`, `ECONNRESET`, а заодно `invalid_grant` и `PAYMENT_REQUIRED`.
 * Одна такая ошибка переводила портал на установившего на десять минут, а в лог шла неправда
 * «портал не принимает служебного пользователя». Какой код портал вернёт на самом деле, не
 * замерено: окажется другим — запись упадёт честно, с текстом портала в логе, и код добавится сюда.
 * ⚠ `ACCESS_DENIED` на создании бывает и без всякого ответственного (у установившего нет прав на
 * смарт-процесс) — тогда повтор без поля упадёт тем же отказом, память не ставится, цена — один
 * лишний вызов.
 */
const RESPONSIBLE_REFUSAL_CODES = new Set(['CRM_FIELD_ERROR_VALUE_NOT_VALID', 'ACCESS_DENIED'])

/** Сколько помним, что портал не принимает служебного пользователя ответственным (см. ниже). */
export const SYSTEM_USER_REFUSAL_TTL_MS = 10 * 60_000

/**
 * Отказы → до какого момента помним. Ключ — ПАРА «портал + служебный пользователь», а не портал.
 *
 * ⚠ Память живёт в процессе, который пишет элементы (контейнеры `worker`), а новый служебный
 * пользователь записывается событием в ДРУГОМ процессе (обработчик событий — на `backend`). Сброс
 * памяти по событию, как было в первой редакции, чистил пустую карту не того процесса (находка
 * ревью #783). С парой в ключе сбрасывать нечего: новый id — новый ключ, в любом процессе.
 */
const refusedUntil = new Map<string, number>()

const refusalKey = (memberId: string, userId: number): string => `${memberId}|${userId}`

/** Для тестов: модульная память иначе протекает между случаями. */
export function resetSystemUserRefusals(): void {
  refusedUntil.clear()
}

/**
 * Выполнить запись элемента(ов) смарт-процесса с правильным ответственным: служебный пользователь
 * приложения, а где его нет — установивший (решение владельца 2026-09-29: «там где нет такой
 * поддержки — пусть будет везде человек, который всё установил»).
 *
 * ⚠ «Установивший» — это ОТСУТСТВИЕ поля (`null`): документация `crm.item.add` называет умолчание
 * прямо — «идентификатор пользователя, который вызывает метод», а вызываем мы токеном установившего.
 * Отдельного вызова `profile` ради того же ответа не нужно.
 *
 * ⚠ Ответственный спрашивается ЛЕНИВО — только когда писатель действительно создаёт элемент — и один
 * раз на запись. Найденному по маркеру элементу он не нужен, и сбой чтения базы не имеет права
 * ломать дозапись колонок существующего элемента (находка ревью).
 *
 * ⚠ «Нет поддержки» бывает ДВУХ видов, и второй ловится только ответом портала. Первый — события не
 * было (ноль в колонке: локальное приложение, установка до этой правки). Второй — событие было, но
 * портал не принимает служебного пользователя ответственным. Замерить это заранее негде, поэтому:
 * создание элемента со служебным пользователем ОТКАЗАНО кодом из `RESPONSIBLE_REFUSAL_CODES` → та же
 * запись повторяется без поля, то есть на установившем. Повтор безопасен: писатели find-or-create по
 * маркеру, и то, что успело создаться, найдётся, а не задвоится.
 *
 * ⚠ Отказ запоминается ТОЛЬКО если повтор прошёл: это и есть доказательство, что мешал именно
 * ответственный (больше между двумя попытками не менялось ничего). Помним недолго
 * (`SYSTEM_USER_REFUSAL_TTL_MS`), чтобы разовая причина не выключила служебного пользователя до
 * перезапуска.
 */
export async function withElementResponsible<T>(
  memberId: string,
  deps: { loadSystemUserId: (memberId: string) => Promise<number | null>, now?: () => number },
  write: (responsible: ResponsibleResolver) => Promise<T>
): Promise<T> {
  const now = deps.now ?? Date.now
  const installer: ResponsibleResolver = async () => null
  let systemUserUsed: number | null = null
  let chosen: Promise<number | null> | undefined
  const primary: ResponsibleResolver = () => {
    chosen ??= (async () => {
      const id = await deps.loadSystemUserId(memberId)
      if (id === null) return null
      const key = refusalKey(memberId, id)
      const until = refusedUntil.get(key)
      if (until !== undefined) {
        if (until > now()) return null
        refusedUntil.delete(key) // истёкшее — прочь, иначе карта копила бы мусор
      }
      systemUserUsed = id
      return id
    })()
    return chosen
  }
  try {
    return await write(primary)
  } catch (e) {
    const code = portalErrorCode(e).toUpperCase()
    const refusal = RESPONSIBLE_REFUSAL_CODES.has(code) && portalErrorMethod(e) === 'crm.item.add'
    if (systemUserUsed === null || !refusal) throw e
    log.warning(`portal ${memberId}: портал отказал в записи элемента на служебного пользователя ${systemUserUsed} (${code}) — повторяем на установившем`)
    const result = await write(installer)
    refusedUntil.set(refusalKey(memberId, systemUserUsed), now() + SYSTEM_USER_REFUSAL_TTL_MS)
    log.warning(`portal ${memberId}: на установившем запись прошла — служебного пользователя этот портал ответственным не принимает; ближайшие ${SYSTEM_USER_REFUSAL_TTL_MS / 60_000} мин элементы идут на установившего`)
    return result
  }
}
