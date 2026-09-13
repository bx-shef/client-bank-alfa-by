// CSV-выгрузка выписки Приорбанка (замерено на боевом файле, #707) — четвёртый формат ручной
// загрузки. Разделитель `;`, кодировка windows-1251, перевод строки `\n`.
//
// Раскладка файла:
//   1–6  шапка: банк и его БИК, НАШ счёт и период, исполнитель, тип счёта и ВАЛЮТА, владелец;
//   8    строка заголовков колонок — по ней и определяем формат;
//   9    входящее сальдо;
//   10…  операции;
//   ниже «Обороты» и «Исходящее сальдо», затем «Запрос обработан».
//
// ⚠ НАПРАВЛЕНИЕ НАЗЫВАЕТ САМ БАНК — две отдельные колонки «Номинал.Дебет» и «Номинал.Кредит».
// Это главное отличие от звёздочного формата (#700), где направление пришлось выводить сведением
// сальдо: здесь гадать не о чем, а строка, в которой обе колонки нулевые либо обе ненулевые,
// считается НЕЧИТАЕМОЙ, а не относится к какой-то стороне наугад.
//
// ⚠ КОЛОНКИ ИЩЕМ ПО ИМЕНИ, а не по номеру. Номер — свойство одной замеренной выгрузки; банк
// добавит колонку в середину, и разбор по индексам молча начнёт брать УНП из поля суммы. Имя
// расходится громко: колонка не нашлась — отказ с текстом.
//
// ⚠ СЧЁТ КОНТРАГЕНТА ПРИХОДИТ С ПРОБЕЛАМИ (`BY69 PJCB3012 0822301000000933`). Поиску компании
// это не мешает (`findCompanyByAccount` нормализует номер сам), а вот «Исключения» сравнивают
// ТОЧНО: счёт, скопированный админом из выписки, не совпал бы со счётом из карточки, и правило
// молча не работало бы. Поэтому пробелы снимаем ЗДЕСЬ, на входе.

import type { NormalizeContext, StatementItem, OperationDirection } from '~/types/statement'
import { parseBankAmount, round2 } from '~/utils/money'

/** Тот же потолок ввода, что у соседних текстовых форматов (DoS-гард #19). */
export const MAX_PRIOR_CSV_CHARS = 20_000_000

const SEP = ';'

/** Имена колонок ровно как их пишет банк. Отсюда же — маркер формата. */
const COL = {
  date: 'Дата док.',
  docNum: 'N док.',
  bic: 'Корреспондент.Код',
  account: 'Корреспондент.Счет',
  unp: 'Корреспондент.УНП',
  name: 'Корреспондент.Название',
  debit: 'Номинал.Дебет',
  credit: 'Номинал.Кредит',
  purpose: 'Назначение'
} as const

/** Строка операции после раскладки по именам колонок. */
export interface PriorCsvRow {
  /** Дата операции, `ГГГГ-ММ-ДД`. */
  date: string
  docNum: string
  bic: string
  /** Счёт контрагента, уже без пробелов. */
  counterpartyAccount: string
  unp: string
  name: string
  /** Сырые строки сумм — разбирает нормализатор, ему же решать, что значит нечитаемая. */
  debit: string
  credit: string
  purpose: string
}

export interface PriorCsvParsed {
  /** Наш счёт из шапки. */
  account: string
  /** Валюта счёта из шапки (`BYN`), пустая — если банк её не написал. */
  currency: string
  rows: PriorCsvRow[]
}

/** Похож ли текст на этот формат: где-то в начале стоит строка заголовков колонок банка. */
export function isPriorCsv(text: string): boolean {
  return headerLineIndex(text.slice(0, 8192).split(/\r?\n/)) >= 0
}

/** Индекс строки заголовков колонок, либо −1. Ищем по ПАРЕ имён: одно имя могло бы случайно
 *  встретиться в назначении платежа, пара в одной строке через `;` — нет. */
function headerLineIndex(lines: string[]): number {
  return lines.findIndex(l => l.includes(COL.date + SEP) && l.includes(COL.debit + SEP))
}

/**
 * Белорусский IBAN: `BY` + две контрольные цифры + ЧЕТЫРЕ буквы банка + ДВАДЦАТЬ знаков.
 *
 * ⚠ Длина хвоста именно 20, и первая редакция ошибочно ждала 16 — тогда шапка не читалась вовсе,
 * а наш счёт молча оставался пустым. Поймано тестом, а не чтением: пустой счёт не роняет разбор,
 * он просто уезжает в CRM без нашей стороны.
 */
export const IBAN_BY = /\b(BY\d{2}[A-Z]{4}[0-9A-Z]{20})\b/

/** `дд.мм.гггг` → `ГГГГ-ММ-ДД`. Невалидная дата — пустая строка (решает вызывающий). */
export function isoFromDotted(dotted: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((dotted ?? '').trim())
  if (!m) return ''
  const [, d, mo, y] = m
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) {
    return ''
  }
  return `${y}-${mo}-${d}`
}

/** Начинается ли строка файла с даты — ЕДИНСТВЕННЫЙ признак операции.
 *
 * ⚠ Число колонок для этого не годится, хотя и напрашивается: замерено, что у операции их 12, у
 * входящего сальдо 11, у оборотов 8 — то есть счётчик развёл бы три случая СЛУЧАЙНО, и первая же
 * выгрузка с другим числом пустых хвостов утащила бы сальдо в операции. Сальдо и обороты никогда
 * не начинаются с даты: там текст («Входящее сальдо на …», «Обороты»). */
function isOperationLine(cells: string[]): boolean {
  return isoFromDotted(cells[0] ?? '') !== ''
}

/** Наш счёт и валюта из шапки. Счёт банк пишет дважды (строки «ВЫПИСКА ПО СЧЕТУ» и «Счет
 *  клиента»), валюту — рядом со вторым. */
function readHeader(lines: string[]): { account: string, currency: string } {
  let account = ''
  let currency = ''
  for (const line of lines.slice(0, 8)) {
    const flat = line.replace(/\s+/g, ' ')
    const acc = IBAN_BY.exec(flat)
    if (acc && !account) account = acc[1]!
    // «Счет клиента*** BY17… BYN Пассивный» — валюта следующим токеном за счётом.
    const cur = new RegExp(IBAN_BY.source + '\\s+([A-Z]{3})\\b').exec(flat)
    if (cur && !currency) currency = cur[2]!
  }
  return { account, currency }
}

/**
 * Разобрать файл. Бросает на чужом содержимом, на пропавшей колонке и на РАСХОЖДЕНИИ ОБОРОТОВ
 * с суммой операций.
 *
 * ⚠ Сверка оборотов — та же бесплатная проверка целостности, что подвал `*3*N*` у звёздочного
 * формата (#700): банк САМ написал, сколько всего прошло по дебету и по кредиту, и обрезанная
 * выгрузка остаётся синтаксически корректной. Без сверки приложение молча импортировало бы ЧАСТЬ
 * выписки — а частичная выписка выглядит как полная и расходится с банком только при сверке
 * сальдо, то есть много позже. Замерено на боевом файле: 1441,81 и 2830,00 сошлись до копейки.
 */
export function parsePriorCsv(content: string, maxChars = MAX_PRIOR_CSV_CHARS): PriorCsvParsed {
  const text = content.length > maxChars ? content.slice(0, maxChars) : content
  const lines = text.split(/\r?\n/)
  const headerAt = headerLineIndex(lines)
  if (headerAt < 0) {
    throw new Error('Файл не похож на CSV-выписку Приорбанка (нет строки заголовков колонок)')
  }

  const header = lines[headerAt]!.split(SEP).map(c => c.trim())
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

  const { account, currency } = readHeader(lines)
  const rows: PriorCsvRow[] = []
  let debitTotal: number | null = null
  let creditTotal: number | null = null

  for (const line of lines.slice(headerAt + 1)) {
    if (!line.trim()) continue
    const cells = line.split(SEP).map(c => c.trim())
    if (isOperationLine(cells)) {
      rows.push({
        date: isoFromDotted(cells[idx.date] ?? ''),
        docNum: cells[idx.docNum] ?? '',
        bic: cells[idx.bic] ?? '',
        // Пробелы снимаем здесь — см. преамбулу модуля.
        counterpartyAccount: (cells[idx.account] ?? '').replace(/\s+/g, ''),
        unp: cells[idx.unp] ?? '',
        name: cells[idx.name] ?? '',
        debit: cells[idx.debit] ?? '',
        credit: cells[idx.credit] ?? '',
        purpose: cells[idx.purpose] ?? ''
      })
      continue
    }
    // ⚠ СТРОКА ОБОРОТОВ НЕ ВЫРОВНЕНА ПО КОЛОНКАМ ОПЕРАЦИЙ, и это ЗАМЕРЕНО на боевом файле:
    // `Обороты ;;;;;1 441,81;2 830,00;` — суммы стоят в 6-й и 7-й ячейках, тогда как у операций
    // те же дебет и кредит лежат в 8-й и 9-й. Первая редакция брала их по индексам заголовка,
    // не находила чисел и объявляла исправный файл обрезанным. Поэтому берём ЧИСЛА, а не ячейки:
    // в строке их ровно два, в порядке «дебет, кредит».
    if (/^Обороты/i.test(cells[0] ?? '')) {
      const numbers = cells.map(parseBankAmount).filter(Number.isFinite)
      if (numbers.length === 2) {
        debitTotal = numbers[0]!
        creditTotal = numbers[1]!
      }
    }
  }

  assertTurnovers(rows, debitTotal, creditTotal)
  return { account, currency, rows }
}

/**
 * Сверка оборотов.
 *
 * ⚠ Сравниваем ОКРУГЛЁННЫЕ суммы, а не сырые: складывая копейки в double, легко получить
 * `1441.8099999999999`, и строгое равенство отвергало бы исправный файл — то есть проверка
 * целостности сама стала бы источником ложных отказов.
 * ⚠ Отсутствующая строка оборотов — ОТКАЗ, как и пропавший подвал у звёздочного формата: при
 * оборванной закачке теряется именно ХВОСТ файла, то есть сама проверка, и «сверяем, если есть»
 * защищало бы ровно не от того случая, ради которого написано.
 */
function assertTurnovers(rows: PriorCsvRow[], debitTotal: number | null, creditTotal: number | null): void {
  if (debitTotal === null || creditTotal === null) {
    throw new Error(
      'В выписке нет строки «Обороты» — скорее всего файл выгрузился не до конца. Выгрузите его '
      + 'заново.'
    )
  }
  let debit = 0
  let credit = 0
  for (const row of rows) {
    const d = parseBankAmount(row.debit)
    const c = parseBankAmount(row.credit)
    if (Number.isFinite(d)) debit += d
    if (Number.isFinite(c)) credit += c
  }
  if (round2(debit) !== round2(debitTotal) || round2(credit) !== round2(creditTotal)) {
    throw new Error(
      `Выписка неполная: банк указал обороты ${round2(debitTotal)} / ${round2(creditTotal)}, `
      + `а сумма операций в файле — ${round2(debit)} / ${round2(credit)}. Скорее всего файл `
      + 'выгрузился не до конца, выгрузите его заново.'
    )
  }
}

/**
 * Направление по двум колонкам.
 *
 * ⚠ Ровно одна из сторон обязана быть ненулевой. Обе нулевые — платежа не было; обе ненулевые —
 * такого банк не пишет, и значит формат сменился. В обоих случаях `null`, и строка уходит в
 * «не прочитали», а не относится к стороне наугад: неверное направление это не потеря строки, а
 * НЕВЕРНОЕ число в карточке компании, которое выглядит достоверным.
 */
export function priorCsvDirection(debit: number, credit: number): OperationDirection | null {
  const d = Number.isFinite(debit) ? round2(debit) : Number.NaN
  const c = Number.isFinite(credit) ? round2(credit) : Number.NaN
  if (!Number.isFinite(d) || !Number.isFinite(c)) return null
  if (d > 0 && c === 0) return 'debit'
  if (c > 0 && d === 0) return 'credit'
  return null
}

/**
 * Ключ идемпотентности операции.
 *
 * ⚠ Дата обязательна, хотя в замеренном файле номера документов уникальны (7 из 7). У соседнего
 * формата голый номер оказался неуникальным на боевых данных — 44 повтора из 251 — и схлопнул бы
 * операции МОЛЧА. Класть в ключ то, чья уникальность держится на одном файле, незачем: дата
 * ничего не стоит.
 */
export function priorCsvDocId(row: PriorCsvRow): string {
  if (!row.docNum) return ''
  return `${row.date}|${row.docNum}`
}

/**
 * Развернуть разобранный файл в операции.
 *
 * ⚠ Нулевые по обеим колонкам строки считаются НЕ платежами (как переоценка у звёздочного
 * формата), а нечитаемые — отдельно: человеку это разные новости, и сводить их в одно число
 * значило бы спрятать вторую за первой.
 */
export function normalizePriorCsvRows(
  parsed: PriorCsvParsed,
  ctx: NormalizeContext
): { items: StatementItem[], nonPayment: number, unreadable: number } {
  const items: StatementItem[] = []
  let nonPayment = 0
  let unreadable = 0

  for (const row of parsed.rows) {
    const debit = parseBankAmount(row.debit)
    const credit = parseBankAmount(row.credit)
    const direction = priorCsvDirection(debit, credit)
    const amount = round2(direction === 'debit' ? debit : credit)

    if (!row.date || !Number.isFinite(debit) || !Number.isFinite(credit)) {
      unreadable += 1
      continue
    }
    // Обе колонки нулевые — записи банка без движения денег.
    if (round2(debit) === 0 && round2(credit) === 0) {
      nonPayment += 1
      continue
    }
    if (!direction || amount <= 0) {
      unreadable += 1
      continue
    }
    // ⚠ Валюта — из ШАПКИ: выписка этого вида выгружается по ОДНОМУ счёту, и своей валюты у
    // строки нет вовсе. Пустая валюта — отказ, а не «наверное BYN»: она доехала бы до заголовка
    // дела, до реестра и до разнесения, которое сверяет валюту и не нашло бы цель никогда.
    const currency = parsed.currency || (ctx.currency ?? '')
    if (!currency) {
      unreadable += 1
      continue
    }
    items.push({
      account: ctx.account || parsed.account,
      docId: priorCsvDocId(row),
      docNum: row.docNum,
      direction,
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

/** Контракт `StatementNormalizer` — только операции; отброшенные с разбивкой отдаёт
 *  `normalizePriorCsvRows`, и вызывающий обязан их показать. */
export function normalizePriorCsv(parsed: PriorCsvParsed, ctx: NormalizeContext): StatementItem[] {
  return normalizePriorCsvRows(parsed, ctx).items
}
