// Выписка ОАО «Бакай Банк» в PDF (#737) — замерено на боевой выгрузке «Выписка по счету RUB …».
//
// Таблица: Дата опер. дня · Дата исполнения · № док · Отправитель/Получатель · Детализация ·
// Пополнение · Списание · Остаток.
//
// ⚠ Направление здесь НАЗЫВАЕТ САМ БАНК — двумя колонками, — в отличие от МБАНКа, где его
// приходится выводить сведением сальдо. Поэтому и обработка разная: там «Дт» вопреки назначению
// оказался расходом, здесь гадать не о чем. Общего парсера у двух банков нет и быть не может —
// ровно по той же причине, по которой два CSV разбираются порознь (#707).
//
// ⚠ Служебная строка «Остаток на конец N» стоит ВНУТРИ записи и В КОЛОНКЕ СУММ. Операцией она не
// является (это промежуточный остаток), и отбрасывается явно — по тексту, а не по координате:
// её `x` плавает вместе с шириной числа.
//
// ⚠ Обороты СВЕРЯЮТСЯ («Итого оборотов: Пополнение … Списание …»), как у звёздочного формата
// сверяется подвал: разъехавшиеся колонки — самая дорогая ошибка этого формата, и она бесплатно
// ловится сложением.

import type { NormalizeContext, StatementItem } from '~/types/statement'
import type { PdfLine, PdfPage } from '~/utils/pdfTextLayout'
import {
  HEADER_BAND_PT,
  amountColumnText,
  columnBounds,
  groupLines,
  headerXNear,
  lineText,
  pageText,
  splitIntoBlocks,
  textColumnText
} from '~/utils/pdfTextLayout'
import { parseBankAmount, round2 } from '~/utils/money'
import { clientBankDateToIso } from '~/utils/clientBankStatement'

/** Подпись банка в шапке. */
const BANK_MARKER = 'Бакай Банк'
/** Заголовок, по которому находится шапка таблицы. */
const HEADER_DETAIL = 'Детализация'
/** Служебная строка внутри записи — промежуточный остаток, не операция. */
const RUNNING_BALANCE_PREFIX = 'Остаток на конец'

/** Границы одной колонки. */
type Bounds = { from: number, to: number }

export interface BakaiPdfHeader {
  account: string
  currency: string
  openingBalance: number
  closingBalance: number
  /** Итог «Пополнение» из подвала, `NaN` если не прочитан. */
  totalCredit: number
  /** Итог «Списание» из подвала, `NaN` если не прочитан. */
  totalDebit: number
}

export interface BakaiPdfRow {
  date: string
  docNum: string
  /** Имя контрагента без его реквизитов. */
  counterparty: string
  /** Счёт контрагента — он стоит отдельной строкой под именем. */
  account: string
  purpose: string
  credit: string
  debit: string
}

export interface BakaiPdfParsed {
  header: BakaiPdfHeader
  rows: BakaiPdfRow[]
}

/** Это выписка Бакай Банка? Подпись банка плюс заголовок таблицы. */
export function isBakaiPdf(pages: PdfPage[]): boolean {
  const text = pages.map(pageText).join('\n')
  return text.includes(BANK_MARKER) && text.includes('Выписка по счету') && text.includes(HEADER_DETAIL)
}

/** `Выписка по счету RUB 1240020001579082` → валюта и счёт (у этого банка валюта ПЕРЕД счётом). */
function parseAccountLine(text: string): { account: string, currency: string } {
  const m = text.match(/Выписка по счету\s+([A-Z]{3})\s+([0-9]{6,32})/)
  return { account: m?.[2] ?? '', currency: m?.[1] ?? '' }
}

/** Первое число в строке, начинающейся с подписи. */
function labelledAmount(lines: PdfLine[], label: string): number {
  for (const line of lines) {
    if (!lineText(line).startsWith(label)) continue
    for (const cell of line.cells) {
      const n = parseBankAmount(cell.text)
      if (Number.isFinite(n)) return n
    }
  }
  return Number.NaN
}

/**
 * Итоги оборотов из подвала: `Пополнение 1 433 000,00` и `Списание 1 064 000,00`.
 *
 * ⚠ ОБА итога приходят ОДНИМ обрывком текста — замерено: ячейка целиком выглядит как
 * «Пополнение 1 433 000,00 | Списание 1 064 000,00». Поэтому подпись ищется ВНУТРИ текста, а не
 * в его начале, и число берётся сразу за ней. Первая редакция искала начало строки и не находила
 * «Списание» вовсе — сверка оборотов молча превращалась в «сверять нечем», то есть страховка
 * была на месте и не работала.
 *
 * ⚠ Та же подпись стоит и в ЗАГОЛОВКЕ колонки, но там за ней числа нет, поэтому заголовок сам
 * себя и отсеивает — отдельной проверки не нужно.
 */
function turnover(lines: PdfLine[], label: string): number {
  for (const line of lines) {
    for (const cell of line.cells) {
      const t = cell.text.trim()
      const at = t.indexOf(label)
      if (at < 0) continue
      const m = t.slice(at + label.length).match(/-?\d[\d\s.,]*/)
      if (m) {
        const n = parseBankAmount(m[0])
        if (Number.isFinite(n)) return n
      }
    }
  }
  return Number.NaN
}

function allLines(pages: PdfPage[]): PdfLine[] {
  return pages.flatMap(p => groupLines(p.items))
}

/** Разобрать выписку в шапку и строки таблицы. */
export function parseBakaiPdf(pages: PdfPage[]): BakaiPdfParsed {
  const lines = allLines(pages)
  const text = lines.map(lineText).join('\n')
  const { account, currency } = parseAccountLine(text)
  const header: BakaiPdfHeader = {
    account,
    currency,
    openingBalance: labelledAmount(lines, 'Входящий остаток'),
    closingBalance: labelledAmount(lines, 'Исходящий остаток'),
    totalCredit: turnover(lines, 'Пополнение'),
    totalDebit: turnover(lines, 'Списание')
  }

  const headerLine = lines.find(l => l.cells.some(c => c.text.trim().startsWith(HEADER_DETAIL)))
  if (!headerLine) return { header, rows: [] }
  const anchorY = headerLine.y

  // ⚠ Заголовков ДАТ два («Дата опер. дня» и «Дата исполнения»), и включить их в раскладку
  // ОБЯЗАТЕЛЬНО: без них левая граница колонки контрагента уходит в минус бесконечность, и в имя
  // плательщика попадают дата, время и обрывок подписи шапки. Замерено: «дня BALICKAa … 16:54:16».
  const xDays = lines
    .filter(l => Math.abs(l.y - anchorY) <= HEADER_BAND_PT)
    .flatMap(l => l.cells)
    .filter(c => c.text.trim().startsWith('Дата'))
    .map(c => c.x)
    .sort((a, b) => a - b)
  const xParty = headerXNear(lines, '№ док', anchorY)
  const xDetail = headerXNear(lines, HEADER_DETAIL, anchorY)
  const xCredit = headerXNear(lines, 'Пополнение', anchorY)
  const xDebit = headerXNear(lines, 'Списание', anchorY)
  const xBalance = headerXNear(lines, 'Остаток', anchorY)
  if (
    xParty === null || xDetail === null || xCredit === null || xDebit === null || xBalance === null
    || xDays.length === 0
  ) {
    return { header, rows: [] }
  }

  const [cParty, cDetail, cCredit, cDebit] = columnBounds(
    [xParty, xDetail, xCredit, xDebit, xBalance, ...xDays]
  ) as [Bounds, Bounds, Bounds, Bounds, Bounds, ...Bounds[]]

  // ⚠ Дата и время стоят ЛЕВЕЕ колонки контрагента, а номер документа — ВНУТРИ неё: банк
  // объединил подпись «№ док Отправитель/Получатель» в один заголовок, то есть колонок там две, а
  // заголовок один. Поэтому левый блок разбирается по СОДЕРЖИМОМУ (дата по маске), а номер
  // документа и счёт контрагента вынимаются из ячеек колонки контрагента по длине числа —
  // делить их координатой значило бы зашить раскладку одной выгрузки.
  const afterHeader = lines.filter(l => l.y < anchorY - HEADER_BAND_PT)
  const endAt = afterHeader.findIndex(l => lineText(l).startsWith('Исходящий остаток'))
  const body = (endAt < 0 ? afterHeader : afterHeader.slice(0, endAt))
    .filter(l => !lineText(l).startsWith(RUNNING_BALANCE_PREFIX))

  // Якорь записи — строка, где банк назвал сумму: у Бакая обе суммы записи стоят на одной строке.
  const isAnchor = (line: PdfLine): boolean => {
    const c = parseBankAmount(amountColumnText([line], cCredit.from, cCredit.to))
    const d = parseBankAmount(amountColumnText([line], cDebit.from, cDebit.to))
    return Number.isFinite(c) || Number.isFinite(d)
  }

  const rows = splitIntoBlocks(body, isAnchor).map((block) => {
    const leftCells = block
      .flatMap(l => l.cells.filter(c => c.x < cParty.from))
      .map(c => c.text.trim())
      .filter(Boolean)
    // Числовидные ячейки колонки контрагента: длинное число — его счёт, короткое — номер
    // документа. Счёт у обоих замеренных контрагентов 16 цифр, номер документа — 7.
    const partyNumbers = block
      .flatMap(l => l.cells.filter(c => c.x >= cParty.from && c.x < cParty.to))
      .map(c => c.text.trim())
      .filter(t => /^\d+$/.test(t))
    return {
      date: leftCells.find(t => /^\d{2}\.\d{2}\.\d{4}$/.test(t)) ?? '',
      docNum: partyNumbers.find(t => t.length >= 5 && t.length <= 11) ?? '',
      counterparty: textColumnText(block, cParty.from, cParty.to),
      account: partyNumbers.find(t => t.length >= 12) ?? '',
      // ⚠ Назначение забирает ВСЕ нечисловые ячейки правее начала детализации, а не только те,
      // что влезли до середины между заголовками. Замерено на боевом файле: хвост назначения
      // (`NIa USLU`) стоит правее этой середины, то есть формально в колонке «Пополнение», и
      // обрезался МОЛЧА — назначение уезжало в CRM клиента без конца фразы. Числа сюда попасть
      // не могут: их отсеивает сам `textColumnText`, а служебный «Остаток на конец» выброшен из
      // тела выше.
      purpose: textColumnText(block, cDetail.from, Number.POSITIVE_INFINITY),
      credit: amountColumnText(block, cCredit.from, cCredit.to),
      debit: amountColumnText(block, cDebit.from, cDebit.to)
    }
  })

  return { header, rows }
}

/**
 * Строки таблицы → операции приложения.
 *
 * ⚠ Ненулевые обе суммы — ОТКАЗ, как и у МБАНКа: банк такую запись не выдаёт, а выбирать одну из
 * двух наугад значило бы придумать половину платежа.
 */
export function normalizeBakaiPdfRows(
  parsed: BakaiPdfParsed,
  ctx: NormalizeContext
): { items: StatementItem[], nonPayment: number, unreadable: number } {
  const items: StatementItem[] = []
  let nonPayment = 0
  let unreadable = 0
  const account = ctx.account || parsed.header.account
  const currency = parsed.header.currency || ctx.currency || ''

  for (const row of parsed.rows) {
    const rawCredit = parseBankAmount(row.credit)
    const rawDebit = parseBankAmount(row.debit)
    const credit = Number.isFinite(rawCredit) ? round2(rawCredit) : Number.NaN
    const debit = Number.isFinite(rawDebit) ? round2(rawDebit) : Number.NaN
    const acceptDate = clientBankDateToIso(row.date)

    if (!acceptDate || !currency || (!Number.isFinite(credit) && !Number.isFinite(debit))) {
      unreadable += 1
      continue
    }
    const c = Number.isFinite(credit) ? credit : 0
    const d = Number.isFinite(debit) ? debit : 0
    if (c < 0 || d < 0 || (c > 0 && d > 0)) {
      unreadable += 1
      continue
    }
    if (c === 0 && d === 0) {
      nonPayment += 1
      continue
    }

    items.push({
      account,
      // ⚠ Номер документа у этого банка сквозной и НЕ уникален во времени, поэтому в ключ дедупа
      // идёт и дата — тот же урок, что у звёздочного формата и у МБАНКа.
      docId: `${row.docNum || 'нд'}|${acceptDate}`,
      ...(row.docNum ? { docNum: row.docNum } : {}),
      direction: c > 0 ? 'credit' : 'debit',
      amount: c > 0 ? c : d,
      currency,
      purpose: row.purpose,
      counterparty: {
        name: row.counterparty,
        // ⚠ УНП/ИНН этот банк в выписке НЕ печатает вовсе — оставляем пустым, а не выдумываем из
        // счёта: опознание клиента идёт по счёту и не страдает, а неверный УНП в карточке
        // выглядел бы достоверным.
        unp: '',
        account: row.account
      },
      acceptDate
    })
  }

  return { items, nonPayment, unreadable }
}

/**
 * Сходятся ли обороты банка с суммой разобранных операций.
 *
 * `null` — сверять нечем; это НЕ «сошлось».
 */
export function bakaiTurnoverCheck(
  header: BakaiPdfHeader,
  items: StatementItem[]
): { credit: { expected: number, actual: number }, debit: { expected: number, actual: number }, ok: boolean } | null {
  if (!Number.isFinite(header.totalCredit) || !Number.isFinite(header.totalDebit)) return null
  const sum = (dir: 'credit' | 'debit'): number =>
    round2(items.filter(i => i.direction === dir).reduce((s, i) => s + i.amount, 0))
  const credit = { expected: round2(header.totalCredit), actual: sum('credit') }
  const debit = { expected: round2(header.totalDebit), actual: sum('debit') }
  return { credit, debit, ok: credit.expected === credit.actual && debit.expected === debit.actual }
}
