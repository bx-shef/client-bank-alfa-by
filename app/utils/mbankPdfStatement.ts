// Выписка МБАНКа в PDF (#737) — замерено на боевой выгрузке «Выписка по счету … KGS».
//
// Таблица: Документ · Дата операции · Корреспондент · Оборот Дт · Оборот Кт · Назначение платежа.
//
// ⚠ НАПРАВЛЕНИЕ ЗДЕСЬ ОБРАТНО ИНТУИЦИИ, и это ЗАМЕР, а не чтение документации (её у нас нет).
// Строки в колонке «Оборот Дт» назначением своим называют «Пополнение счета» — соблазн прочитать
// их приходом велик. Но сальдо говорит обратное: 7 687,22 − 12 437,20 + 30 000,00 = 25 250,02, и
// это ровно исходящий остаток из той же выписки. То есть «Дт» — списание (пополняется ЧУЖОЙ счёт,
// карта физлица), «Кт» — зачисление. Поверить назначению значило бы показать расход приходом —
// не «потерять» операцию, а выдать в карточке компании достоверно выглядящее неверное число.
//
// ⚠ Поэтому сальдо СВЕРЯЕТСЯ (как подвал `*3*N*` у звёздочного формата и обороты у CSV): вход
// плюс приходы минус расходы обязаны дать исходящий остаток. Это бесплатная проверка того, что
// колонки не разъехались, — а разъехаться им есть на чём, см. `pdfTextLayout.ts`.
//
// ⚠ Строку ИТОГО сверять НЕЛЬЗЯ: замерено, что оба числа приходят ОДНИМ обрывком текста
// («ИТОГО 12,437.2030,000.00») — разделителя между ними нет ни в каком виде, и разрезать их можно
// только гаданием о числе знаков. Сальдо даёт тот же ответ и не требует гадать.

import type { NormalizeContext, StatementItem } from '~/types/statement'
import type { PdfLine, PdfPage } from '~/utils/pdfTextLayout'
import {
  HEADER_BAND_PT,
  amountColumnText,
  columnBounds,
  columnText,
  groupLines,
  headerXNear,
  headerXsNear,
  joinColumnText,
  lineText,
  pageText,
  splitIntoBlocks
} from '~/utils/pdfTextLayout'
import { parseBankAmount, round2 } from '~/utils/money'
import { clientBankDateToIso } from '~/utils/clientBankStatement'

/** Подпись банка в шапке — по ней формат и опознаётся. */
const BANK_MARKER = 'МБАНК'
/** Заголовок, без которого таблицы нет. */
const HEADER_DEBIT = 'Оборот'

/** Границы одной колонки. */
type Bounds = { from: number, to: number }

/** Разобранная шапка выписки. */
export interface MbankPdfHeader {
  /** Наш счёт. */
  account: string
  /** Валюта счёта (`KGS`). */
  currency: string
  /** Входящий остаток, `NaN` если не прочитан. */
  openingBalance: number
  /** Исходящий остаток, `NaN` если не прочитан. */
  closingBalance: number
}

/** Строка таблицы до нормализации — ровно то, что стояло в ячейках. */
export interface MbankPdfRow {
  document: string
  date: string
  counterparty: string
  debit: string
  credit: string
  purpose: string
}

export interface MbankPdfParsed {
  header: MbankPdfHeader
  rows: MbankPdfRow[]
}

/**
 * Это выписка МБАНКа?
 *
 * Требуем подпись банка И заголовок таблицы: одной подписи мало — она стоит и в реквизитах
 * контрагента чужой выписки, а перепутанный формат читался бы колонками не того банка.
 */
export function isMbankPdf(pages: PdfPage[]): boolean {
  const text = pages.map(pageText).join('\n')
  return text.includes(BANK_MARKER) && text.includes('Выписка по счету') && text.includes(HEADER_DEBIT)
}

/** `Выписка по счету 1034023100216390 KGS (Пассивный)` → счёт и валюта. */
function parseAccountLine(text: string): { account: string, currency: string } {
  const m = text.match(/Выписка по счету\s+([0-9]{6,32})\s+([A-Z]{3})/)
  return { account: m?.[1] ?? '', currency: m?.[2] ?? '' }
}

/** `Входящий остаток: 7,687.22 на 01.06.2026` — число берём из колонки, а не из строки целиком. */
function parseBalance(lines: PdfLine[], label: string): number {
  for (const line of lines) {
    const text = lineText(line)
    if (!text.startsWith(label)) continue
    for (const cell of line.cells) {
      const n = parseBankAmount(cell.text)
      if (Number.isFinite(n)) return n
    }
  }
  return Number.NaN
}

/** Строки всех страниц подряд — таблица переносится со страницы на страницу. */
function allLines(pages: PdfPage[]): PdfLine[] {
  return pages.flatMap(p => groupLines(p.items))
}

/**
 * Разобрать выписку в шапку и строки таблицы.
 *
 * ⚠ Зона таблицы обрывается по СОДЕРЖИМОМУ («ИТОГО» / «Исходящий остаток»), а не по координате.
 * Подвал стоит ниже последней записи на произвольном расстоянии, и правило «дальше N точек —
 * значит не запись» зависело бы от того, сколько операций поместилось на страницу.
 */
export function parseMbankPdf(pages: PdfPage[]): MbankPdfParsed {
  const lines = allLines(pages)
  const text = lines.map(lineText).join('\n')
  const { account, currency } = parseAccountLine(text)
  const header: MbankPdfHeader = {
    account,
    currency,
    openingBalance: parseBalance(lines, 'Входящий остаток'),
    closingBalance: parseBalance(lines, 'Исходящий остаток')
  }

  // ⚠ Опора — строка «Документ»: заголовки ищем ТОЛЬКО рядом с ней. Слово «Дата» встречается
  // выше по документу («Дата формирования информации»), и поиск по всему листу брал его — см.
  // `headerXNear`.
  const headerLine = lines.find(l => lineText(l).startsWith('Документ'))
  if (!headerLine) return { header, rows: [] }
  const anchorY = headerLine.y

  const xDoc = headerXNear(lines, 'Документ', anchorY)
  const xDate = headerXNear(lines, 'Дата', anchorY)
  const xParty = headerXNear(lines, 'Корреспондент', anchorY)
  const xPurpose = headerXNear(lines, 'Назначение', anchorY)
  // ⚠ Заголовок «Оборот» СТОИТ ДВАЖДЫ (Дт и Кт) на одной строке, поэтому берём обе его позиции,
  // а не первую: иначе кредит читался бы как часть назначения — то есть все приходы исчезли бы
  // разом, и сальдо это заметило бы, а глаз нет.
  const oborots = headerXsNear(lines, HEADER_DEBIT, anchorY)
  const xDebit = oborots[0]
  const xCredit = oborots[1]
  if (
    xDoc === null || xDate === null || xParty === null || xPurpose === null
    || xDebit === undefined || xCredit === undefined
  ) {
    return { header, rows: [] }
  }

  const [cDoc, cDate, cParty, cDebit, cCredit, cPurpose] = columnBounds(
    [xDoc, xDate, xParty, xDebit, xCredit, xPurpose]
  ) as [Bounds, Bounds, Bounds, Bounds, Bounds, Bounds]

  // ⚠ Тело начинается НИЖЕ всей шапки таблицы, а не со следующей строки: шапка двухэтажная, и
  // её нижний этаж («операции», «Дт», «Кт») иначе попадал в первую запись — подпись «Дт»
  // приклеивалась к сумме (`Дт3,109.30`), и сумма переставала читаться вовсе.
  const afterHeader = lines.filter(l => l.y < anchorY - HEADER_BAND_PT)
  const endAt = afterHeader.findIndex((l) => {
    const t = lineText(l)
    return t.startsWith('ИТОГО') || t.startsWith('Исходящий остаток')
  })
  const body = endAt < 0 ? afterHeader : afterHeader.slice(0, endAt)

  // ⚠ Якорь записи — строка с НОМЕРОМ ДОКУМЕНТА («ПП № 722»), а не с суммой. Сумма для этого не
  // годится: банк переносит длинное число внутри ячейки, и у записи на 30 000 она оказалась на
  // ТРЁХ разных строках — по сумме запись разрезалась бы на три, и каждый кусок недосчитывался бы
  // своих денег. Номер документа у записи ровно один (строка «от 08.06.2026» его не содержит).
  const isAnchor = (line: PdfLine): boolean => columnText(line, cDoc.from, cDoc.to).includes('№')

  const rows = splitIntoBlocks(body, isAnchor).map(block => ({
    document: joinColumnText(block, cDoc.from, cDoc.to),
    date: joinColumnText(block, cDate.from, cDate.to),
    counterparty: joinColumnText(block, cParty.from, cParty.to),
    // ⚠ Суммы склеиваются ВСТЫК: банк переносит длинное число внутри ячейки (`30,000.0` + `0`).
    debit: amountColumnText(block, cDebit.from, cDebit.to),
    credit: amountColumnText(block, cCredit.from, cCredit.to),
    purpose: joinColumnText(block, cPurpose.from, cPurpose.to)
  }))

  return { header, rows }
}

/** `ПП № 722 от 04.06.2026` → номер документа. */
function docNumber(document: string): string {
  return document.match(/№\s*([0-9A-Za-zА-Яа-я\-/]+)/)?.[1] ?? ''
}

/** Счёт контрагента из его реквизитов: `… счет № 1033020214474526, …`. */
function partyAccount(text: string): string {
  return text.match(/сч[её]т\s*№?\s*([0-9]{8,34})/i)?.[1] ?? ''
}

/** УНП/ИНН контрагента из тех же реквизитов. */
function partyUnp(text: string): string {
  return text.match(/ИНН\s*([0-9]{6,20})/i)?.[1] ?? ''
}

/** Имя контрагента — всё до первого реквизита. */
function partyName(text: string): string {
  return text.split(/,?\s*ИНН\s/i)[0]?.trim().replace(/,$/, '') ?? ''
}

/**
 * Строки таблицы → операции приложения.
 *
 * ⚠ Обе суммы ненулевые — ОТКАЗ, а не «возьмём первую»: запись, где банк указал и дебет, и
 * кредит, мы прочитать не умеем, и выбор любой из них был бы выдумкой.
 */
export function normalizeMbankPdfRows(
  parsed: MbankPdfParsed,
  ctx: NormalizeContext
): { items: StatementItem[], nonPayment: number, unreadable: number } {
  const items: StatementItem[] = []
  let nonPayment = 0
  let unreadable = 0
  const account = ctx.account || parsed.header.account
  const currency = parsed.header.currency || ctx.currency || ''

  for (const row of parsed.rows) {
    const rawDebit = parseBankAmount(row.debit)
    const rawCredit = parseBankAmount(row.credit)
    const debit = Number.isFinite(rawDebit) ? round2(rawDebit) : Number.NaN
    const credit = Number.isFinite(rawCredit) ? round2(rawCredit) : Number.NaN
    const acceptDate = clientBankDateToIso(row.date)

    if (!acceptDate || !currency || (!Number.isFinite(debit) && !Number.isFinite(credit))) {
      unreadable += 1
      continue
    }
    const d = Number.isFinite(debit) ? debit : 0
    const c = Number.isFinite(credit) ? credit : 0
    if (d < 0 || c < 0 || (d > 0 && c > 0)) {
      unreadable += 1
      continue
    }
    // Денег по счёту не двигалось — служебная запись банка, не отказ разбора.
    if (d === 0 && c === 0) {
      nonPayment += 1
      continue
    }

    const num = docNumber(row.document)
    items.push({
      account,
      // ⚠ В ключе дедупа ОБЯЗАТЕЛЬНА дата: номер документа у банка сквозной по годам, и ключ
      // `<счёт>|<номер>` молча схлопнул бы платежи разных периодов (тот же урок, что у
      // звёздочного формата).
      docId: `${num || 'нд'}|${acceptDate}`,
      ...(num ? { docNum: num } : {}),
      direction: c > 0 ? 'credit' : 'debit',
      amount: c > 0 ? c : d,
      currency,
      purpose: row.purpose,
      counterparty: {
        name: partyName(row.counterparty),
        unp: partyUnp(row.counterparty),
        account: partyAccount(row.counterparty)
      },
      acceptDate
    })
  }

  return { items, nonPayment, unreadable }
}

/**
 * Сходится ли сальдо: вход + приходы − расходы = выход.
 *
 * Возвращает `null`, когда сверять нечем (банк не дал остатков) — это НЕ «сошлось»: вызывающий
 * обязан различать «проверили и сошлось» и «проверить было нечем».
 */
export function mbankBalanceCheck(
  header: MbankPdfHeader,
  items: StatementItem[]
): { expected: number, actual: number, ok: boolean } | null {
  if (!Number.isFinite(header.openingBalance) || !Number.isFinite(header.closingBalance)) return null
  const delta = items.reduce((sum, it) => sum + (it.direction === 'credit' ? it.amount : -it.amount), 0)
  const actual = round2(header.openingBalance + delta)
  const expected = round2(header.closingBalance)
  return { expected, actual, ok: expected === actual }
}
