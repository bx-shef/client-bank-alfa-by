// Registry write for the payments smart process (#575).
//
// ⚠ WHY THIS EXISTS. The SP is called «Импорт выписки: платежи» and the owner expected a REGISTRY —
// every operation of the statement, searchable and filterable in CRM. The code instead wrote an
// element only inside the `allocate` branch, i.e. only when a client company had been identified
// AND a target found. On a portal whose payers are not in CRM (measured: 366 distinct payer
// accounts, zero matches) that condition never holds, so the SP stayed empty beside a working
// import — and nothing said why. Agreed with the owner 2026-08-22: the element is written for
// EVERY operation, independent of `autoDistribute`, of client identification and of any target.
//
// ⚠ ORDER, not a race. The allocation path (`writeLedgerAllocation`/`writeTriggerLedgerFact`) calls
// the same `ensurePaymentElement` by the same marker — but WITHOUT the registry payload, and that
// function does not update an element it finds. So «whichever runs first» is not a harmless
// symmetry: if allocation ran first the element would be created bare and this write would find the
// marker taken and return quietly, leaving the registry columns empty exactly for the payments that
// DID match. `handleCrmSyncJob` therefore calls the registry write BEFORE the allocation block, and
// a test with shared element state pins that order (an earlier version of that test used two
// independent fakes and passed against the broken order — measured).

import { ensurePaymentElement } from './distributionLedgerWrite'
import { buildRegistryFillCall } from '../../app/utils/distributionLedger'
import { dedupKey } from '../../app/utils/statement'
import { BANK_LABELS } from '../../app/utils/bankLabels'
import type { PaymentRegistryFields } from '../../app/utils/distributionLedger'
import type { StatementItem, BankProviderId } from '../../app/types/statement'
import type { SpRef } from '../../app/config/distributionSp'
import type { RestCall } from './companyLookup'
import { neutralizeBb } from '../../app/utils/activity'

/** Human labels for the direction column — «приход»/«расход» read as data, `credit`/`debit` do not. */
export const DIRECTION_LABELS = { credit: 'Приход', debit: 'Расход' } as const

/**
 * Map one statement operation onto the registry columns. Pure.
 *
 * ⚠ The bank is carried as the HUMAN label (`Альфа-Банк`), not the provider id: this column is read
 * in a CRM list by an accountant, and `alfa-by` is our internal token. An unknown provider falls
 * back to its id rather than to an empty cell — «we do not have a name for this» is still a fact.
 */
export function buildRegistryFields(item: StatementItem, provider: BankProviderId): PaymentRegistryFields {
  return {
    // ⚠ Наши собственные значения — плательщик их не касается.
    // ⚠ Дата — ТОЛЬКО календарная часть: поле типа `date`, а Bitrix24 переводит присланный момент в
    // часовой пояс портала прежде, чем взять дату (замерено 2026-08-22), поэтому сырой
    // `2026-08-21T23:30:00Z` лёг бы 22 августа. Банк называет дату проводки, а не момент времени.
    operationDate: item.acceptDate.slice(0, 10),
    direction: DIRECTION_LABELS[item.direction],
    ownAccount: item.account,
    bank: BANK_LABELS[provider] ?? provider,
    // ⚠ А эти четыре ПИШЕТ ПЛАТЕЛЬЩИК, и через `neutralizeBb` их прогоняет КАЖДЫЙ писатель в
    // проекте — описание дела, сообщение в чат, оповещения об ошибках. Без этого реестр был бы
    // единственным местом, куда назначение платежа попадает сырым, — и местом самым читаемым: в
    // список СП бухгалтер смотрит чаще, чем в описание дела. Счёт и УНП скобок не содержат никогда,
    // поэтому на настоящих данных это тождественная замена и срабатывает только на подделке.
    counterparty: neutralizeBb(item.counterparty.name),
    counterpartyAccount: neutralizeBb(item.counterparty.account),
    counterpartyUnp: neutralizeBb(item.counterparty.unp),
    purpose: neutralizeBb(item.purpose)
  }
}

/**
 * Ensure the payment element for `item` exists AND carries the registry columns. Returns its id.
 * Idempotent by the operation key (the same one the activity marker uses) — a redelivery finds the
 * existing element instead of adding a second.
 *
 * ⚠ Найденному элементу колонки ДОПИСЫВАЮТСЯ (#578). `ensurePaymentElement` их не дописывает —
 * это find-or-create без ветки update, — и пока запись реестра удавалась с первого раза и шла
 * первой, разницы не было. Она появляется ровно там, где нужен долговременный ретрай: к моменту
 * повтора элемент мог быть создан ГОЛЫМ (разнесением или прежним упавшим прогоном), и без
 * дописывания повтор «успешно» не делал бы ничего, а колонки не появились бы уже никогда.
 *
 * ⚠ Лишний вызов платится ТОЛЬКО когда элемент уже был: на счастливом пути (создали сами) его нет.
 */
export async function writePaymentRegistryViaRest(
  item: StatementItem,
  companyId: string | null,
  provider: BankProviderId,
  paymentSp: SpRef,
  call: RestCall
): Promise<string> {
  const registry = buildRegistryFields(item, provider)
  const { id, created } = await ensurePaymentElement(paymentSp, {
    opportunity: item.amount,
    currency: item.currency,
    marker: dedupKey(item),
    ...(companyId ? { companyId } : {}),
    registry
  }, call)
  if (!created) {
    const fill = buildRegistryFillCall(paymentSp, id, registry)
    if (fill) await call(fill.method, fill.params)
  }
  return id
}
