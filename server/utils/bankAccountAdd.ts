// Добавление счёта к существующему подключению ПОД ГРАНТОВЫМ ЛОКОМ (#23).
//
// Отдельная функция, а не три строки в роуте, по той же причине, что у `makeLockedRename` (#509):
// здесь принимаются два решения, каждое из которых легко принять неправильно и невозможно заметить
// снаружи — (1) лок берётся ПО ГРАНТУ, тот же, что держит обновление токена; (2) исчерпание
// ожидания это «занято, повторите», а не ошибка. В `defineEventHandler` поверх живых
// `dbQuery`/`withAdvisoryLock` оба были бы непроверяемы.
//
// ⚠ Зачем лок вообще, если мы только вставляем новую строку: `INSERT … SELECT` при read committed
// не блокируется на незакоммиченном `UPDATE` обновления — он читает ПРЕДЫДУЩУЮ версию исходной
// строки. В окно между «обновление записало ротированную пару» и «обновление закоммитилось» новая
// строка получила бы refresh, который банк уже отозвал, и предъявила бы его на своём тике. Разбор —
// в докблоке `addBankAccountToGrant`.

import type { AddAccountOutcome } from './bankTokenStore'
import { bankRefreshLockKey, isLockTimeout } from './bankRefreshLock'
import { BANK_REFRESH_LOCK_WAIT } from './dbLock'
import type { QueryFn } from './tokenStore'
import type { BankProviderId } from '../../app/types/statement'

/** Исход добавления плюс `busy` — «строку сейчас держит обновление токена, повторите». */
export type AddAccountLockedOutcome = AddAccountOutcome | 'busy'

export interface LockedAddAccountDeps {
  withLock: <T>(key: string, fn: (q: QueryFn) => Promise<T>, opts?: { lockWait?: string }) => Promise<T>
  add: (
    q: QueryFn, memberId: string, sourceId: number, expectedAccountKey: string, accountKey: string
  ) => Promise<AddAccountOutcome>
  /**
   * Банк и грант исходной строки по её неизменяемому `id` (#517).
   *
   * ⚠ Читается ДО лока, и это безопасно: грант строки не меняется никогда — его ставит только
   * OAuth-колбэк при создании. Худшее, что успевает случиться, — строку удалили, и тогда само
   * добавление честно вернёт `gone`. Пустой грант даёт `unmarked` там же, внутри.
   */
  grantOf: (memberId: string, id: number) => Promise<{ provider: BankProviderId, grantId: string } | null>
}

export function makeLockedAddAccount(deps: LockedAddAccountDeps) {
  return async function add(
    memberId: string, sourceId: number, expectedAccountKey: string, accountKey: string
  ): Promise<AddAccountLockedOutcome> {
    const src = await deps.grantOf(memberId, sourceId)
    // Строки нет — незачем занимать лок ради заведомого `gone`.
    if (!src) return 'gone'
    // Грант не размечен — добавлять нечего, и лок брать не за что: `addBankAccountToGrant` ответит
    // `unmarked` сам, а лок по счёту не пересёкся бы с обновлением этой строки в любом случае.
    if (src.grantId === '') return 'unmarked'
    try {
      return await deps.withLock(
        bankRefreshLockKey(memberId, src.provider, expectedAccountKey, src.grantId),
        q => deps.add(q, memberId, sourceId, expectedAccountKey, accountKey),
        { lockWait: BANK_REFRESH_LOCK_WAIT }
      )
    } catch (e) {
      // ⚠ Ждать можно 2 с, а держит лок сетевой POST к банку с потолком 15 с. Значит «не дождался»
      // это ШТАТНЫЙ исход при исправно работающем обновлении, а не сбой БД: человеку нужен совет
      // повторить, а не сообщение об ошибке. Тот же разбор, что у `makeLockedRename`.
      if (isLockTimeout(e)) return 'busy'
      throw e
    }
  }
}
