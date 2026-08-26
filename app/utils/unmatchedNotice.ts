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
// ⚠ ДВА УДАЛЕНИЯ — ДВЕ РАЗНЫЕ ПРИЧИНЫ, и путать их нельзя (находка ревью #43).
//   • ДЕЛО удалить ОБЯЗАТЕЛЬНО: приложение узнаёт «операция уже записана» по маркеру самого дела,
//     и дедуп отсеивает её ДО записи (`getActivityId → continue` стоит раньше `writePaymentRegistry`
//     в `handleCrmSyncJob`). Пока дело есть, повторный импорт просто пропустит операцию.
//   • ЭЛЕМЕНТ СП на дедуп не влияет ВОВСЕ — повтор найдёт его по маркеру и не задвоит. Удалять его
//     нужно по другой причине: дозапись (`buildRegistryFillCall`) обновляет только колонки реестра,
//     а `companyId` в них не входит, поэтому найденный элемент навсегда останется без ссылки на
//     контрагента, даже когда дело перезапишется правильно.
// Прежняя редакция объединяла оба удаления в один шаг с объяснением про дедуп — то есть
// приписывала элементу свойство, которого у него нет.
//
// ⚠ ТИП компании называется по направлению платежа: приход — «Клиент», расход — «Поставщик».
// Это подсказка ЧЕЛОВЕКУ, куда заводить; на поиск тип не влияет — приложение ищет только по счёту
// в реквизитах. Оговорка вынесена и в сам текст: админ, заведший контрагента как «Партнёр», иначе
// решит, что импорт не сработал именно поэтому, и пойдёт чинить не то.
//
// ⚠ ПОДРОБНОСТЬ РАЗНАЯ ПО ПОВЕРХНОСТЯМ, и это осознанно. Полная процедура живёт в справке; заметка
// в карточке несёт короткую выжимку (человек смотрит именно на этот платёж); сообщение в ЧАТ —
// самое короткое, потому что повторяется на КАЖДУЮ неопознанную операцию, а на ненастроенном
// портале это все операции разом (в живом прогоне — 500 дел). Четыре предложения инструкции,
// умноженные на поток, превращают чат ошибок в шум, ради которого его перестают читать.
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
    + `Как исправить: завести компанию контрагента (тип «${counterpartyKind(item)}» — на поиск он не `
    + `влияет, приложение ищет по счёту) и вписать счёт ${acc} в её реквизиты, затем удалить это `
    + 'дело — при следующем импорте операция запишется на контрагента. Удалить дело обязательно: '
    + 'пока оно есть, импорт считает операцию уже записанной. Элемент смарт-процесса «Платежи» '
    + 'удалите заодно — иначе он останется без ссылки на контрагента. '
    + 'Перепривязать это дело к другой компании нельзя: Bitrix24 не даёт сменить владельца '
    + 'у созданного дела.'
}

/** Error-chat notice about an unmatched-client operation. `recordedToMyCompany` distinguishes the
 *  two §5 sub-cases: recorded on my company (needs the counterparty created + a re-import) vs not
 *  recorded at all (my company also not found). Deal tone + app prefix per §5.
 *
 *  ⚠ Хвост НАМЕРЕННО короткий — см. шапку модуля: это сообщение приходит на каждую неопознанную
 *  операцию, поэтому процедура здесь названа одной строкой со ссылкой на справку, а не расписана. */
export function buildUnmatchedMessage(item: StatementItem, recordedToMyCompany: boolean): string {
  const kind = item.direction === 'credit' ? 'приход' : 'расход'
  const acc = neutralizeBb(item.counterparty.account) || '—'
  const money = `${formatMoney(item.amount)} ${item.currency}`
  const tail = recordedToMyCompany
    ? `Записано в вашу компанию. Чтобы платёж встал к контрагенту, заведите его в CRM (тип `
    + `«${counterpartyKind(item)}») со счётом ${acc} в реквизитах и удалите это дело — порядок `
    + 'в справке приложения. Перепривязать созданное дело вручную нельзя.'
    : 'В CRM не записано: не найдена и ваша компания по нашему счёту — заведите реквизит и повторите.'
  return `[Импорт выписки из клиент-банка] Клиент не определён: ${kind} ${money}, счёт контрагента ${acc}. ${tail}`
}
