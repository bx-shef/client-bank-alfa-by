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
// The allocation path (`writeLedgerAllocation`) still ensures the same element by the same marker
// before adding its distribution row, so the two paths converge instead of racing: whichever runs
// first creates it, the other finds it.

import { ensurePaymentElement } from './distributionLedgerWrite'
import { dedupKey } from '../../app/utils/statement'
import { BANK_LABELS } from '../../app/utils/bankLabels'
import type { PaymentRegistryFields } from '../../app/utils/distributionLedger'
import type { StatementItem, BankProviderId } from '../../app/types/statement'
import type { SpRef } from '../../app/config/distributionSp'
import type { RestCall } from './companyLookup'

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
    operationDate: item.acceptDate,
    direction: DIRECTION_LABELS[item.direction],
    counterparty: item.counterparty.name,
    counterpartyAccount: item.counterparty.account,
    counterpartyUnp: item.counterparty.unp,
    purpose: item.purpose,
    ownAccount: item.account,
    bank: BANK_LABELS[provider] ?? provider
  }
}

/**
 * Ensure the payment element for `item` exists, carrying the registry columns. Returns its id.
 * Idempotent by the operation key (the same one the activity marker uses) — a redelivery finds the
 * existing element instead of adding a second.
 */
export async function writePaymentRegistryViaRest(
  item: StatementItem,
  companyId: string | null,
  provider: BankProviderId,
  paymentSp: SpRef,
  call: RestCall
): Promise<string> {
  const { id } = await ensurePaymentElement(paymentSp, {
    opportunity: item.amount,
    currency: item.currency,
    marker: dedupKey(item),
    ...(companyId ? { companyId } : {}),
    registry: buildRegistryFields(item, provider)
  }, call)
  return id
}
