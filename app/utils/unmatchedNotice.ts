// Text for the UNMATCHED-client case (#91, PROCESSING.md §2 Этап C.2 / §5): the payer company
// (counterparty) was not found by its settlement account. Per the spec the operation is NOT
// lost — it is recorded on MY company's timeline with a reason, and a notice goes to the error
// chat so an operator attaches it. Pure text builders (no I/O): the card note goes into the
// configurable activity layout; the chat message is sent to the error chat by the transport.
//
// SECURITY: the counterparty account comes from the bank statement (payer-controlled) → it is
// BB-neutralized before entering the card / chat (same guard as the rest of the operation card).

import type { StatementItem } from '~/types/statement'
import { formatMoney, neutralizeBb } from '~/utils/activity'

/** Reason block shown on the my-company fallback activity: the payer wasn't identified. */
export function unmatchedClientNote(item: StatementItem): string {
  const acc = neutralizeBb(item.counterparty.account) || '—'
  return `Клиент не определён: компания по расчётному счёту контрагента ${acc} не найдена в CRM. `
    + 'Операция записана в вашу компанию — привяжите её вручную или заведите реквизиты контрагента.'
}

/** Error-chat notice about an unmatched-client operation. `recordedToMyCompany` distinguishes the
 *  two §5 sub-cases: recorded on my company (needs manual linking) vs not recorded at all (my
 *  company also not found). Deal tone + app prefix per §5. */
export function buildUnmatchedMessage(item: StatementItem, recordedToMyCompany: boolean): string {
  const kind = item.direction === 'credit' ? 'приход' : 'расход'
  const acc = neutralizeBb(item.counterparty.account) || '—'
  const money = `${formatMoney(item.amount)} ${item.currency}`
  const tail = recordedToMyCompany
    ? 'Записано в вашу компанию — требует ручной привязки.'
    : 'В CRM не записано: не найдена и ваша компания по нашему счёту — заведите реквизит и повторите.'
  return `[Импорт выписки из клиент-банка] Клиент не определён: ${kind} ${money}, счёт контрагента ${acc}. ${tail}`
}
