// Builds the ERROR-chat message for a CRM deletion that damaged the SP-ledger (#109,
// PROCESSING.md §9.2/§5). Pure: takes the entity kind + id (+ optional freed-row count), returns
// the BB-code message for im.message.add, or null when the kind needs no notice. Sent to the
// portal's error chat by server/utils/deletionErrorNotify.
//
// PRIVACY (§9.2): the message carries ONLY the entity kind + id (+ a count) — NEVER amounts,
// accounts, counterparty or purpose. The entity is already deleted, so there is no payer-controlled
// text here; the id is an ingestion-validated digit string. `neutralizeBb` is applied defensively so
// even a future non-digit id can't inject BB-code into the operator chat.

import { neutralizeBb } from '~/utils/activity'

/** Deletion kinds that warrant an error-chat notice (subset of DeletionEntityKind). */
export type DeletionErrorKind = 'deal' | 'invoice' | 'company' | 'payment-carrier'

/** RU label per entity kind (CRM-internal, not payer text). */
const KIND_RU: Record<DeletionErrorKind, string> = {
  'deal': 'сделка',
  'invoice': 'смарт-счёт',
  'company': 'компания',
  'payment-carrier': 'элемент-носитель платежа'
}

/**
 * Error-chat message for a ledger-affecting deletion (§9.2), or null for a kind that needs none:
 *
 *   [b]⚠️ Удалена цель разнесения[/b]                 (deal / invoice)
 *   Удалён смарт-счёт #39. Освобождено распределений: 2.
 *   Затронутые платежи требуют повторного распределения.
 *
 *   [b]⚠️ Повреждена структура распределения[/b]      (payment-carrier)
 *   Удалён элемент-носитель платежа #100 — проверьте и при необходимости переобработайте операцию.
 *
 *   [b]⚠️ Удалена компания[/b]                        (company)
 *   Удалена компания #7, связанная с платежом — потерян ответственный; переназначьте вручную.
 */
export function buildDeletionErrorMessage(kind: DeletionErrorKind, id: string, opts: { freed?: number } = {}): string | null {
  const safeId = neutralizeBb(String(id))
  const label = KIND_RU[kind]
  if (!label) return null

  if (kind === 'company') {
    return [
      '[b]⚠️ Удалена компания[/b]',
      `Удалена компания #${safeId}, связанная с платежом — потерян ответственный; переназначьте вручную.`
    ].join('\n')
  }

  if (kind === 'payment-carrier') {
    return [
      '[b]⚠️ Повреждена структура распределения[/b]',
      `Удалён ${label} #${safeId} — проверьте и при необходимости переобработайте операцию.`
    ].join('\n')
  }

  // deal / invoice — an amount/trigger target was deleted; its distributions were freed.
  const freed = Number.isInteger(opts.freed) && (opts.freed as number) > 0 ? opts.freed : undefined
  return [
    '[b]⚠️ Удалена цель разнесения[/b]',
    freed !== undefined
      ? `Удалён ${label} #${safeId}. Освобождено распределений: ${freed}.`
      : `Удалён ${label} #${safeId}.`,
    'Затронутые платежи требуют повторного распределения.'
  ].join('\n')
}
