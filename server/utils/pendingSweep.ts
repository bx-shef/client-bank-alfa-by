// Свип брошенных ожидающих подключений (#485).
//
// Подключение без выбранного счёта ложится в `bank_tokens` под временным ключом `~pending:` и до
// сих пор жило там ВЕЧНО: `isPendingAccountKey` только исключал такие строки из опроса, но ничего
// не удалял. Сценариев минимум три, и все обычные — админ закрыл вкладку после банка, подключение
// сорвалось уже после сохранения токена, подключили не тот банк и ушли.
//
// ⚠ Копятся они не по одной, а гроздьями: `nonce` берётся из подписанного state и всякий раз
// другой (так и задумано — иначе два параллельных connect'а затирали бы друг друга), поэтому каждый
// повтор создаёт НОВУЮ строку. В списке накапливаются неотличимые «счёт не выбран», и какая из них
// живая — снаружи не понять. Экран готовности при этом держит строку «Банк подключён» красной,
// пока есть хоть одна незавершённая, то есть мусор ещё и глушит настоящий сигнал.
//
// ⚠ Решение — НЕ SQL-предикат по возрасту. Правило «можно ли ещё довести это подключение до
// рабочего» уже сформулировано в `bankTokenLifetime.ts` и учитывает срок согласия банка,
// измеренность срока refresh и его отсутствие; повторив его в SQL, мы завели бы вторую копию,
// которая разойдётся с первой молча (ровно то, о чём предупреждает шапка того модуля). Поэтому
// строки читаются, решение принимает чистая функция, удаление идёт точечно.

import { abandonedPending, PENDING_MAX_AGE_DAYS } from '../../app/utils/bankTokenLifetime'
import { bankRefreshLockKey, isLockTimeout } from './bankRefreshLock'
import type { BankAccountInfo } from './bankTokenStore'
import type { BankProviderId } from '../../app/types/statement'
import { sanitizeForLog } from './logSanitize'
import type { QueryFn } from './tokenStore'

export interface PendingSweepDeps {
  now: () => number
  /** Все строки подключений без расшифровки секретов — снимок для отбора кандидатов. */
  list: () => Promise<BankAccountInfo[]>
  /** Тот же advisory-лок, которым сериализованы обновление токена и выбор счёта (#509). */
  withLock: <T>(key: string, fn: (q: QueryFn) => Promise<T>) => Promise<T>
  /** Перечитать ОДНУ строку внутри лока. `null` — её уже нет. */
  reread: (q: QueryFn, memberId: string, provider: BankProviderId, accountKey: string) => Promise<BankAccountInfo | null>
  /** Точечное удаление; member-scoped в самом WHERE. */
  remove: (q: QueryFn, memberId: string, provider: BankProviderId, accountKey: string) => Promise<boolean>
  maxAgeDays?: number
}

/**
 * Удалить брошенные ожидающие подключения. Возвращает, сколько снесено.
 *
 * ⚠ РЕШЕНИЕ ПЕРЕПРОВЕРЯЕТСЯ ПОД ЛОКОМ, и это не перестраховка. Отбор идёт по снимку, снятому одним
 * SELECT в начале тика, а между снимком и удалением строку успевает тронуть keep-alive: он
 * НАМЕРЕННО продлевает и ожидающие подключения (#489 — «админ вернётся завтра»), и у неизмеренного
 * провайдера (Приор) такая строка живёт в `due` сколь угодно долго. Без перечитывания выходило
 * ровно наоборот задуманному: keep-alive сходил в банк, доказал, что подключение живое, обновил
 * пару — а свип сносил его следом, потому что судил по возрасту ДО обновления. То есть свип
 * обесценивал механику, написанную ради этих же строк.
 *
 * ⚠ Лок — тот же, что у обновления токена и выбора счёта (#509). Прежняя классификация
 * `deleteBankToken` как «удаление терминально, лок не нужен» верна для НАМЕРЕННОГО разового
 * действия человека («Отключить», удаление приложения): там «снести, что бы ни делал параллельный
 * рефреш» и есть желаемая семантика. Свип — автоматическая эвристика по протухшему снимку, и для
 * неё это правило не годится.
 *
 * ⚠ Не дождались лока — молча пропускаем строку. Держатель это работающий рефреш (POST к банку до
 * 15 с), и «занято» здесь не сбой, а «не сейчас»: строка брошена, подметём на следующем тике.
 * Писать про это в лог значило бы шуметь при штатной работе.
 *
 * ⚠ Ошибка на ОДНОЙ строке не отменяет остальные: свип идёт по всем порталам сразу, и один битый
 * ряд не должен оставлять мусор у всех прочих. Считаем только фактически удалённые.
 */
export async function sweepAbandonedPending(deps: PendingSweepDeps): Promise<number> {
  const maxAge = deps.maxAgeDays ?? PENDING_MAX_AGE_DAYS
  let removed = 0
  for (const row of await deps.list()) {
    if (!abandonedPending(row, deps.now(), maxAge)) continue
    try {
      const done = await deps.withLock(
        bankRefreshLockKey(row.memberId, row.provider, row.accountKey),
        async (q) => {
          const fresh = await deps.reread(q, row.memberId, row.provider, row.accountKey)
          // Строки уже нет (успел «Отключить» или параллельная реплика) — считать нечего.
          if (!fresh) return false
          // Перечит по СВЕЖИМ данным и текущим часам: keep-alive мог омолодить строку, пока мы
          // ждали лок, и тогда сносить её нельзя — она только что доказала свою жизнеспособность.
          if (!abandonedPending(fresh, deps.now(), maxAge)) return false
          return deps.remove(q, row.memberId, row.provider, row.accountKey)
        }
      )
      if (done) removed++
    } catch (e) {
      if (isLockTimeout(e)) continue
      // Без `member_id` и без ключа счёта: строка попадает в общий лог сервиса (docs/PRIVACY.md).
      console.error('[retention] pending sweep: %s row failed: %s', row.provider, sanitizeForLog((e as Error)?.message ?? ''))
    }
  }
  return removed
}

/** Верхняя граница потолка возраста. Именованная — как `MAX_TOMBSTONE_TTL_DAYS` у соседа. */
export const MAX_PENDING_AGE_DAYS = 30

/** Разбор `PENDING_MAX_AGE_DAYS` из env: клампим в [1, 30], мусор ⇒ дефолт. */
export function resolvePendingMaxAgeDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return PENDING_MAX_AGE_DAYS
  const n = Number(raw)
  if (!Number.isFinite(n)) return PENDING_MAX_AGE_DAYS
  // ⚠ Пол — сутки: меньше суток свип начал бы сносить подключения, которые админ ещё не бросил
  // (банк вечером, номер утром — обычный сценарий, а не небрежность).
  return Math.min(MAX_PENDING_AGE_DAYS, Math.max(1, Math.floor(n)))
}
