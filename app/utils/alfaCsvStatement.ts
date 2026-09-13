// CSV-выгрузка выписки Альфа-Банка (замерено на боевом файле, #707) — пятый формат ручной
// загрузки. Разделитель `;`, кодировка windows-1251.
//
// Раскладка файла:
//   1–6  шапка: БИК, НАШ счёт и период, числовой код валюты, входящий остаток;
//   9    строка заголовков колонок;
//   10   маркер секции ` ; … ; ДЕБЕТ; ; ;`, под ним операции списания;
//        «ИТОГО ОБОРОТ ПО ДЕБЕТУ»;
//        маркер секции `КРЕДИТ`, под ним операции поступления;
//        «ИТОГО ОБОРОТ ПО КРЕДИТУ», «ИСХОДЯЩИЙ ОСТАТОК».
//
// ⚠ ГЛАВНОЕ ОТЛИЧИЕ ОТ CSV ПРИОРБАНКА, при внешнем сходстве: НАПРАВЛЕНИЯ В СТРОКЕ НЕТ. Сумма
// одна («Сумма операции»), а дебет и кредит задаются СЕКЦИЕЙ. Значит разбор обязан держать
// состояние, а строка операции, встреченная ДО первого маркера, — отказ, а не «пусть будет
// расход»: ошибка здесь не теряет операцию, а показывает приход расходом, и число в карточке
// компании выглядит достоверным. Два формата с одним разделителем и разной семантикой — ровно
// тот случай, когда «сделаем один парсер на оба» выглядит экономией и покупает тихую ошибку.
//
// ⚠ ДЕСЯТИЧНЫЙ РАЗДЕЛИТЕЛЬ — ТОЧКА (`10 000.00`), у Приорбанка — запятая. Общий
// `parseBankAmount` принимает обе формы; правило живёт в одном месте (`money.ts`), потому что
// две копии разъехались бы молча.
//
// ⚠ КОЛОНКИ ИЩЕМ ПО ИМЕНИ — тот же довод, что у соседа: номер это свойство одной выгрузки.

import type { NormalizeContext, StatementItem, OperationDirection } from '~/types/statement'
import { currencyFromNumericCode } from '~/utils/clientBankStatement'
import { splitCsvLine, tailCell } from '~/utils/csvLine'
import { parseBankAmount, round2 } from '~/utils/money'
import { IBAN_BY, isoFromDotted } from '~/utils/priorCsvStatement'

/** Тот же потолок ввода, что у соседних текстовых форматов (DoS-гард #19). */
export const MAX_ALFA_CSV_CHARS = 20_000_000

const SEP = ';'

/** Имена колонок ровно как их пишет банк. Отсюда же — маркер формата. */
const COL = {
  date: 'Дата операции',
  docNum: 'Номер документа',
  bic: 'Бик банка-корр.',
  unp: 'УНП',
  account: 'Номер счета',
  amount: 'Сумма операции',
  name: 'Наименование корреспондента',
  purpose: 'Назначение платежа'
} as const

/** Слова-маркеры секций. Сравниваем по ВХОЖДЕНИЮ в строку, где нет даты: банк пишет их в колонке
 *  суммы, а не в первой ячейке. */
const DEBIT_MARK = 'ДЕБЕТ'
const CREDIT_MARK = 'КРЕДИТ'

export interface AlfaCsvRow {
  /** Дата операции, `ГГГГ-ММ-ДД`. */
  date: string
  docNum: string
  bic: string
  unp: string
  /** Счёт контрагента, уже без пробелов (см. довод в `priorCsvStatement`). */
  counterpartyAccount: string
  name: string
  /** Сырая сумма — разбирает нормализатор. */
  amount: string
  purpose: string
  /** Направление, взятое из СЕКЦИИ, в которой строка стояла. */
  direction: OperationDirection
}

export interface AlfaCsvParsed {
  /** Наш счёт из шапки. */
  account: string
  /** Числовой ISO валюты счёта из шапки (`933`). */
  currencyCode: string
  rows: AlfaCsvRow[]
}

/** Похож ли текст на этот формат. */
export function isAlfaCsv(text: string): boolean {
  return headerLineIndex(text.slice(0, 8192).split(/\r?\n/)) >= 0
}

/** Индекс строки заголовков колонок, либо −1. Ищем по ПАРЕ имён — одно могло бы случайно
 *  встретиться в назначении платежа, пара в одной строке через `;` — нет. */
function headerLineIndex(lines: string[]): number {
  return lines.findIndex(l => l.includes(COL.date + SEP) && l.includes(COL.amount + SEP))
}

/** Наш счёт и числовой код валюты из шапки. */
function readHeader(lines: string[]): { account: string, currencyCode: string } {
  let account = ''
  let currencyCode = ''
  for (const line of lines.slice(0, 9)) {
    const acc = IBAN_BY.exec(line.replace(/\s+/g, ' '))
    if (acc && !account) account = acc[1]!
    const cur = /Код\s+валюты:\s*(\d{3})/.exec(line)
    if (cur && !currencyCode) currencyCode = cur[1]!
  }
  return { account, currencyCode }
}

/**
 * Разобрать файл. Бросает на чужом содержимом, на пропавшей колонке, на операции ВНЕ секции и на
 * расхождении оборотов с суммой операций.
 *
 * ⚠ Сверка оборотов — та же бесплатная проверка целостности, что у соседних форматов: банк сам
 * написал итоги по дебету и кредиту, а обрезанная выгрузка остаётся синтаксически корректной.
 * Замерено на боевом файле: 23 516,92 и 24 851,36 сошлись до копейки, и остаток тоже
 * (42 618,10 − 23 516,92 + 24 851,36 = 43 952,54).
 */
export function parseAlfaCsv(content: string, maxChars = MAX_ALFA_CSV_CHARS): AlfaCsvParsed {
  const text = content.length > maxChars ? content.slice(0, maxChars) : content
  const lines = text.split(/\r?\n/)
  const headerAt = headerLineIndex(lines)
  if (headerAt < 0) {
    throw new Error('Файл не похож на CSV-выписку Альфа-Банка (нет строки заголовков колонок)')
  }

  const header = splitCsvLine(lines[headerAt]!, SEP).map(c => c.trim())
  const idx: Record<keyof typeof COL, number> = {} as Record<keyof typeof COL, number>
  for (const [key, title] of Object.entries(COL) as [keyof typeof COL, string][]) {
    const at = header.indexOf(title)
    if (at < 0) {
      throw new Error(
        `В выписке нет колонки «${title}». Похоже, банк изменил формат выгрузки — пришлите файл `
        + 'нам, мы поправим разбор.'
      )
    }
    idx[key] = at
  }

  const { account, currencyCode } = readHeader(lines)
  const rows: AlfaCsvRow[] = []
  let section: OperationDirection | null = null
  let debitTotal: number | null = null
  let creditTotal: number | null = null

  for (const line of lines.slice(headerAt + 1)) {
    if (!line.trim()) continue
    // ⚠ Держим и СЫРЫЕ ячейки: назначение склеивается из хвоста, а по обрезанным копиям пробел
    // после разделителя терялся бы — текст плательщика менялся бы молча.
    const raw = splitCsvLine(line, SEP)
    const cells = raw.map(c => c.trim())
    const date = isoFromDotted(cells[0] ?? '')

    if (date === '') {
      // Не операция: маркер секции либо итоговая строка.
      //
      // ⚠ Порядок проверок важен: строка «ИТОГО ОБОРОТ ПО ДЕБЕТУ» СОДЕРЖИТ слово «ДЕБЕТ», и
      // поиск маркера раньше итога ОТКРЫЛ бы секцию там, где она должна закрыться. На замеренной
      // раскладке это безвредно — сразу за дебетовым итогом идёт маркер «КРЕДИТ», который всё
      // равно переустановит секцию, — и первая версия теста поэтому проходила при ОБОИХ порядках
      // (замерено мутацией). Настоящая цена ошибки в другом: после итога секции быть не должно,
      // и операция под ним обязана получить отказ, а не молча стать расходом.
      const upper = line.toUpperCase()
      if (upper.includes('ИТОГО ОБОРОТ')) {
        // ⚠ У Альфы итог стоит РОВНО в колонке суммы (замерено), в отличие от Приорбанка, где
        // строка оборотов по колонкам не выровнена вовсе. Поэтому здесь индекс, а там — числа;
        // расхождение не случайно, и обобщать его в «одно правило» значило бы подогнать один из
        // двух форматов под другой без замера.
        const total = parseBankAmount(cells[idx.amount] ?? '')
        if (Number.isFinite(total)) {
          if (upper.includes(DEBIT_MARK)) debitTotal = total
          else if (upper.includes(CREDIT_MARK)) creditTotal = total
        }
        section = null
        continue
      }
      if (upper.includes('ОСТАТОК')) {
        section = null
        continue
      }
      if (upper.includes(DEBIT_MARK)) section = 'debit'
      else if (upper.includes(CREDIT_MARK)) section = 'credit'
      continue
    }

    // ⚠ Операция вне секции — ОТКАЗ разбора целиком, а не пропуск строки: раз мы не понимаем
    // структуру файла, любое направление тут было бы догадкой, а пропуск молча потерял бы платёж.
    if (!section) {
      throw new Error(
        'В выписке есть операция вне блоков «ДЕБЕТ»/«КРЕДИТ» — направление платежа определить '
        + 'нечем. Похоже, банк изменил формат выгрузки, пришлите файл нам.'
      )
    }

    rows.push({
      date,
      docNum: cells[idx.docNum] ?? '',
      bic: cells[idx.bic] ?? '',
      unp: cells[idx.unp] ?? '',
      counterpartyAccount: (cells[idx.account] ?? '').replace(/\s+/g, ''),
      name: cells[idx.name] ?? '',
      amount: cells[idx.amount] ?? '',
      // ⚠ Хвостом, а не одной ячейкой: `;` в назначении иначе отрезает его молча (csvLine.ts).
      purpose: tailCell(raw, idx.purpose, SEP),
      direction: section
    })
  }

  assertTurnovers(rows, debitTotal, creditTotal)
  return { account, currencyCode, rows }
}

/** Сверка оборотов — довод и способ сравнения те же, что у CSV Приорбанка. */
function assertTurnovers(rows: AlfaCsvRow[], debitTotal: number | null, creditTotal: number | null): void {
  if (debitTotal === null || creditTotal === null) {
    throw new Error(
      'В выписке нет итогов оборота по дебету и кредиту — скорее всего файл выгрузился не до '
      + 'конца. Выгрузите его заново.'
    )
  }
  let debit = 0
  let credit = 0
  for (const row of rows) {
    const value = parseBankAmount(row.amount)
    if (!Number.isFinite(value)) continue
    if (row.direction === 'debit') debit += value
    else credit += value
  }
  if (round2(debit) !== round2(debitTotal) || round2(credit) !== round2(creditTotal)) {
    throw new Error(
      'Сумма операций не сошлась с оборотами, которые указал банк: по списаниям '
      + `${round2(debitTotal).toFixed(2)} против ${round2(debit).toFixed(2)}, по поступлениям `
      + `${round2(creditTotal).toFixed(2)} против ${round2(credit).toFixed(2)}. Чаще всего это `
      + 'значит, что файл выгрузился не до конца — выгрузите его заново; если повторяется, '
      + 'пришлите файл нам кнопкой отзыва.'
    )
  }
}

/** Ключ идемпотентности — номер документа И дата, по тому же доводу, что у соседних форматов. */
export function alfaCsvDocId(row: AlfaCsvRow): string {
  if (!row.docNum) return ''
  return `${row.date}|${row.docNum}`
}

/** Развернуть разобранный файл в операции. */
export function normalizeAlfaCsvRows(
  parsed: AlfaCsvParsed,
  ctx: NormalizeContext
): { items: StatementItem[], nonPayment: number, unreadable: number } {
  const items: StatementItem[] = []
  let nonPayment = 0
  let unreadable = 0

  for (const row of parsed.rows) {
    const raw = parseBankAmount(row.amount)
    const amount = round2(raw)
    if (!row.date || !Number.isFinite(raw)) {
      unreadable += 1
      continue
    }
    if (amount === 0) {
      nonPayment += 1
      continue
    }
    if (amount < 0) {
      unreadable += 1
      continue
    }
    // ⚠ Валюта — из ШАПКИ (числовой код `933`): выписка выгружается по ОДНОМУ счёту, своей валюты
    // у строки нет. Неизвестный код — отказ строки, а не догадка «раз счёт белорусский, значит
    // BYN»: та же доктрина, что у звёздочного формата.
    const currency = currencyFromNumericCode(parsed.currencyCode) ?? (ctx.currency ?? '')
    if (!currency) {
      unreadable += 1
      continue
    }
    items.push({
      account: ctx.account || parsed.account,
      docId: alfaCsvDocId(row),
      docNum: row.docNum,
      direction: row.direction,
      amount,
      currency,
      purpose: row.purpose,
      acceptDate: row.date,
      counterparty: {
        name: row.name,
        unp: row.unp,
        account: row.counterpartyAccount,
        bic: row.bic
      }
    })
  }

  return { items, nonPayment, unreadable }
}

/** Контракт `StatementNormalizer` — только операции. */
export function normalizeAlfaCsv(parsed: AlfaCsvParsed, ctx: NormalizeContext): StatementItem[] {
  return normalizeAlfaCsvRows(parsed, ctx).items
}
