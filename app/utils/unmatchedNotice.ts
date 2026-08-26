// Text for the UNMATCHED-client case (#91, PROCESSING.md §2 Этап C.2 / §5): the payer company
// (counterparty) was not found by its settlement account. Per the spec the operation is NOT
// lost — it is recorded on MY company's timeline with a reason, and a notice goes to the error
// chat so the accountant can fix it. Pure text builders (no I/O): the card note goes into the
// activity description; the chat message is sent to the error chat by the transport.
//
// ⚠ СОВЕТ «привяжите вручную» БЫЛ НЕВЫПОЛНИМ — и это не придирка к словам, а неверная инструкция,
// которую человек не может исполнить (#43, замечание владельца). Дело создаётся с ВЛАДЕЛЬЦЕМ
// (компанией), и сменить его у существующего дела нельзя: `crm.activity.update` с
// `OWNER_TYPE_ID`/`OWNER_ID` отвечает «Fields is not specified» — замерено на живом портале
// (см. #579 в CLAUDE.md). Значит перетащить уже записанное дело в карточку контрагента
// НЕВОЗМОЖНО в принципе; единственный рабочий путь — завести контрагента и дать приложению
// записать операцию заново.
//
// ⚠ ПОРЯДОК ВАЖЕН, и он ровно такой: (1) завести компанию контрагента и вписать ЕГО расчётный счёт
// в реквизиты, (2) удалить это дело И элемент смарт-процесса «Платежи», (3) дать импорту пройти
// снова. Без шага (2) операция не вернётся никогда: приложение узнаёт «уже записана» по маркеру
// самого дела в CRM и отсеивает её ДО записи — то есть новый импорт просто пропустит её.
//
// ⚠ ТИП компании называется по направлению платежа: приход — «Клиент», расход — «Поставщик».
// Человеку это подсказка, куда заводить; для поиска приложению важен только счёт в реквизитах.
//
// SECURITY: the counterparty account comes from the bank statement (payer-controlled) → it is
// BB-neutralized before entering the card / chat (same guard as the rest of the operation card).

import type { StatementItem } from '~/types/statement'
import { formatMoney, neutralizeBb } from '~/utils/activity'

/** Тип карточки контрагента по направлению платежа — подсказка человеку, куда его заводить.
 *  Приложение ищет компанию ТОЛЬКО по счёту в реквизитах, тип на поиск не влияет. */
function counterpartyKind(item: StatementItem): string {
  return item.direction === 'credit' ? 'Клиент' : 'Поставщик'
}

/** Reason block shown on the my-company fallback activity: the payer wasn't identified. */
export function unmatchedClientNote(item: StatementItem): string {
  const acc = neutralizeBb(item.counterparty.account) || '—'
  return `Клиент не определён: компания по расчётному счёту контрагента ${acc} не найдена в CRM. `
    + 'Операция записана в вашу компанию. '
    + `Чтобы платёж встал к контрагенту: заведите его компанию в CRM (тип «${counterpartyKind(item)}») `
    + `и впишите счёт ${acc} в её реквизиты, затем удалите это дело и элемент смарт-процесса `
    + '«Платежи» — при следующем импорте операция запишется на контрагента. '
    + 'Перепривязать это дело к другой компании нельзя: Bitrix24 не даёт сменить владельца '
    + 'у созданного дела.'
}

/** Error-chat notice about an unmatched-client operation. `recordedToMyCompany` distinguishes the
 *  two §5 sub-cases: recorded on my company (needs the counterparty created + a re-import) vs not
 *  recorded at all (my company also not found). Deal tone + app prefix per §5. */
export function buildUnmatchedMessage(item: StatementItem, recordedToMyCompany: boolean): string {
  const kind = item.direction === 'credit' ? 'приход' : 'расход'
  const acc = neutralizeBb(item.counterparty.account) || '—'
  const money = `${formatMoney(item.amount)} ${item.currency}`
  const tail = recordedToMyCompany
    ? `Записано в вашу компанию. Заведите контрагента (тип «${counterpartyKind(item)}») со счётом `
    + `${acc} в реквизитах, затем удалите это дело и элемент смарт-процесса «Платежи» — операция `
    + 'запишется на него при следующем импорте. Перепривязать созданное дело вручную нельзя.'
    : 'В CRM не записано: не найдена и ваша компания по нашему счёту — заведите реквизит и повторите.'
  return `[Импорт выписки из клиент-банка] Клиент не определён: ${kind} ${money}, счёт контрагента ${acc}. ${tail}`
}
