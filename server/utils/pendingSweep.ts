// Свип брошенных ожидающих подключений (#485).
//
// Подключение без выбранного счёта ложится в `bank_tokens` под временным ключом `~pending:` и до
// сих пор жило там ВЕЧНО: `isPendingAccountKey` только исключает такие строки из опроса, но ничего
// не удаляет. Сценариев минимум три, и все обычные — админ закрыл вкладку после банка, подключение
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
import type { BankAccountInfo } from './bankTokenStore'
import type { BankProviderId } from '../../app/types/statement'

export interface PendingSweepDeps {
  now: () => number
  /** Все строки подключений без расшифровки секретов. */
  list: () => Promise<BankAccountInfo[]>
  /** Точечное удаление; member-scoped в самом WHERE. */
  remove: (memberId: string, provider: BankProviderId, accountKey: string) => Promise<boolean>
  maxAgeDays?: number
}

/**
 * Удалить брошенные ожидающие подключения. Возвращает, сколько снесено.
 *
 * ⚠ Ошибка на ОДНОЙ строке не отменяет остальные: свип идёт по всем порталам сразу, и один битый
 * ряд (или отвалившееся соединение на нём) не должен оставлять мусор у всех прочих. Считаем только
 * фактически удалённые — `remove` отдаёт `false`, если строку уже унесли параллельно.
 */
export async function sweepAbandonedPending(deps: PendingSweepDeps): Promise<number> {
  const nowMs = deps.now()
  const maxAge = deps.maxAgeDays ?? PENDING_MAX_AGE_DAYS
  let removed = 0
  for (const row of await deps.list()) {
    if (!abandonedPending(row, nowMs, maxAge)) continue
    try {
      if (await deps.remove(row.memberId, row.provider, row.accountKey)) removed++
    } catch (e) {
      // Без `member_id` и без ключа счёта: строка попадает в общий лог сервиса (docs/PRIVACY.md).
      console.error('[retention] pending sweep: %s row failed: %s', row.provider, (e as Error)?.message)
    }
  }
  return removed
}

/** Разбор `PENDING_MAX_AGE_DAYS` из env: клампим в [1, 30], мусор ⇒ дефолт. */
export function resolvePendingMaxAgeDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return PENDING_MAX_AGE_DAYS
  const n = Number(raw)
  if (!Number.isFinite(n)) return PENDING_MAX_AGE_DAYS
  // ⚠ Пол — сутки: меньше суток свип начал бы сносить подключения, которые админ ещё не бросил
  // (банк вечером, номер утром — обычный сценарий, а не небрежность).
  return Math.min(30, Math.max(1, Math.floor(n)))
}
