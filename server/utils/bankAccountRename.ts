// Переименование ключа подключения ПОД ЛОКОМ обновления токена (#509).
//
// Отдельная функция, а не три строки в роуте, по одной причине: здесь принимаются два решения,
// каждое из которых легко принять неправильно и невозможно заметить снаружи —
//   1) лок берётся по СТАРОМУ ключу (по новому он не пересечётся с обновлением ни разу);
//   2) исчерпание ожидания лока — это «занято, повторите», а не ошибка.
// В роуте они были бы непроверяемы (`defineEventHandler` поверх живых `dbQuery`/`withAdvisoryLock`),
// а именно их и надо стеречь.

import type { BankProviderId } from '../../app/types/statement'
import type { RenameOutcome } from './bankAccounts'
import { bankRefreshLockKey, isLockTimeout } from './bankRefreshLock'
import { BANK_REFRESH_LOCK_WAIT } from './dbLock'
import type { QueryFn } from './tokenStore'

export interface LockedRenameDeps {
  withLock: <T>(key: string, fn: (q: QueryFn) => Promise<T>, opts?: { lockWait?: string }) => Promise<T>
  rename: (
    q: QueryFn, memberId: string, provider: BankProviderId, fromKey: string, toKey: string
  ) => Promise<'renamed' | 'not-found' | 'conflict'>
  /**
   * Грант подключения, если он размечен (#23) — по нему берётся лок, когда счета делят согласие.
   *
   * ⚠ Читается ДО лока, и это безопасно: грант строки не меняется никогда — его ставит только
   * OAuth-колбэк при создании, а переименование трогает `account_key`. Худшее, что успевает
   * случиться, — строку удалили, и тогда переименование само вернёт `not-found`.
   */
  grantOf?: (memberId: string, provider: BankProviderId, accountKey: string) => Promise<string>
}

/**
 * Собрать `rename`-зависимость для `handleSetBankAccount`, сериализованную с обновлением токена.
 *
 * Без лока две операции спорят за одну строку и обе «успешны»: keep-alive перечитал строку по
 * `~pending:n1`, ушёл в банк (до 15 с), за это время админ дожал выбор счёта, ключ стал `BY01`, и
 * вернувшееся обновление не нашло свою строку. Оно честно не создаёт её заново (#505) — но банк
 * refresh УЖЕ ротировал, а у нас остался потраченный. Снаружи всё цело; умрёт на следующем
 * обновлении, `invalid_grant`, и лечится повторным входом владельца счёта в интернет-банк.
 *
 * ⚠ Отвергнут вариант «не сканировать `~pending:` в keep-alive»: дешевле, но лечит симптом ценой
 * болезни — ожидающее подключение обязано дожить до выбора счёта (его и сканируют намеренно, #489),
 * а без обновления оно тихо умрёт к вечеру.
 */
export function makeLockedRename(deps: LockedRenameDeps) {
  return async function rename(
    memberId: string, provider: BankProviderId, fromKey: string, toKey: string
  ): Promise<RenameOutcome> {
    // Пустая строка (нет функции / грант не размечен) даёт прежний лок по счёту.
    const grantId = (await deps.grantOf?.(memberId, provider, fromKey)) ?? ''
    try {
      // ⚠ Ключ — по `fromKey`. Это НЕ придирка: обновляющая сторона держит строку под тем ключом,
      // который видит СЕЙЧАС, то есть под старым. Лок по `toKey` был бы взят добросовестно и не
      // пересёкся бы с ней ни разу — вся защита превратилась бы в накладные расходы, а дефект
      // остался бы на месте, теперь уже с тестом, утверждающим обратное.
      return await deps.withLock(
        // ⚠ Грант ВАЖНЕЕ ключа счёта, когда он есть: обновление берёт лок по гранту (#23), и лок
        // по счёту не пересёкся бы с ним ни разу — та же дыра, что и с `toKey` абзацем выше.
        bankRefreshLockKey(memberId, provider, fromKey, grantId),
        q => deps.rename(q, memberId, provider, fromKey, toKey),
        { lockWait: BANK_REFRESH_LOCK_WAIT }
      )
    } catch (e) {
      // Ждать можно 2 с (`BANK_REFRESH_LOCK_WAIT`, вместо машинного умолчания в 10 с), а
      // держатель — сетевой POST с потолком 15 с. Значит
      // «не дождался» это ШТАТНЫЙ исход при исправно работающем обновлении, а не сбой БД.
      // ⚠ Только этот код и только он: спутать с настоящей ошибкой значит предложить человеку
      // повторять кнопку, пока не надоест, тогда как причина в другом месте.
      if (isLockTimeout(e)) return 'busy'
      throw e
    }
  }
}
