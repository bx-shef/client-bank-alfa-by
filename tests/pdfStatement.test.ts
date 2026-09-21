import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PdfPage } from '../app/utils/pdfTextLayout'
import {
  amountColumnText,
  columnBounds,
  groupLines,
  headerXNear,
  looksNumeric,
  splitIntoBlocks,
  textColumnText
} from '../app/utils/pdfTextLayout'
import { mbankBalanceCheck, normalizeMbankPdfRows, parseMbankPdf, isMbankPdf } from '../app/utils/mbankPdfStatement'
import { bakaiTurnoverCheck, normalizeBakaiPdfRows, parseBakaiPdf, isBakaiPdf } from '../app/utils/bakaiPdfStatement'
import { detectManualPdfFormat, parseManualPdf } from '../app/utils/manualImport'
import { looksLikePdf } from '../app/utils/pdfExtract'

// Разбор PDF-выписок (#737). Фикстуры — СИНТЕТИЧЕСКИЕ координаты, снятые с боевых файлов: сами
// файлы содержат реквизиты клиента, а репозиторий публичный.
//
// ⚠ Тесты бьют в ЧИСТЫЙ слой, без pdf.js. Это не упрощение ради удобства: pdf.js отвечает ровно
// на вопрос «какие обрывки текста и где стоят», и проверять его нашими тестами — проверять чужую
// библиотеку. Всё, что может соврать в НАШЕМ коде, живёт выше него и проверяется здесь.

function fixture(name: string): PdfPage[] {
  const raw = readFileSync(join(import.meta.dirname, 'fixtures', 'pdf', name), 'utf8')
  return (JSON.parse(raw) as { pages: PdfPage[] }).pages
}

const mbank = (): PdfPage[] => fixture('mbank-layout.json')
const bakai = (): PdfPage[] => fixture('bakai-layout.json')

describe('looksLikePdf', () => {
  it('опознаёт PDF по первым байтам, а не по имени файла', () => {
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7\nrest'))).toBe(true)
    expect(looksLikePdf(new TextEncoder().encode('***** ^Type=400^'))).toBe(false)
  })
})

describe('слой раскладки PDF', () => {
  it('склеивает в одну строку обрывки, разошедшиеся по вертикали в пределах допуска', () => {
    const lines = groupLines([
      { x: 10, y: 100, text: 'левое' },
      { x: 90, y: 97, text: 'правое' },
      { x: 10, y: 80, text: 'следующая' }
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]!.cells.map(c => c.text)).toEqual(['левое', 'правое'])
  })

  it('границы колонок — СЕРЕДИНЫ между заголовками, в порядке входа', () => {
    // ⚠ Порядок входа несущий: вызывающий разбирает результат по своим именам колонок, и
    // отсортированный список отдал бы ему чужие границы.
    const [credit, debit, balance] = columnBounds([624, 692, 759])
    expect(credit!.to).toBe(658)
    expect(debit!.from).toBe(658)
    // Остаток (750) стоит ЛЕВЕЕ своего заголовка (759) — середина всё равно разводит его со
    // «Списанием», а допуск «заголовок минус запас» отдал бы его в колонку расхода.
    expect(750 >= balance!.from).toBe(true)
  })

  it('в колонку суммы идут ТОЛЬКО числовидные ячейки и склеиваются встык', () => {
    const lines = groupLines([
      { x: 600, y: 100, text: 'хвост назначения' },
      { x: 626, y: 100, text: '30,000.0' },
      { x: 626, y: 94, text: '0' }
    ])
    expect(amountColumnText(lines, 590, 700)).toBe('30,000.00')
    expect(textColumnText(lines, 590, 700)).toBe('хвост назначения')
    expect(looksNumeric('30,000.0')).toBe(true)
    expect(looksNumeric('Остаток на конец 434 000,00')).toBe(false)
  })

  it('заголовок ищется РЯДОМ с шапкой таблицы, а не по всему листу', () => {
    const lines = groupLines([
      { x: 212, y: 735, text: 'Дата формирования информации:' },
      { x: 142, y: 666, text: 'Дата' },
      { x: 61, y: 660, text: 'Документ' }
    ])
    expect(headerXNear(lines, 'Дата', 660)).toBe(142)
  })

  it('строка НАД якорем достаётся его записи, а хвост реквизитов не уезжает к следующей', () => {
    // Оба случая замерены на живом файле МБАНКа: ячейка выступает над якорем и тянется вниз.
    // ⚠ Разрывы взяты такими, чтобы строки НЕ склеились в одну (это делает `groupLines` при
    // разнице ≤ 4 точек): здесь проверяется именно разрезание на записи.
    const lines = groupLines([
      { x: 200, y: 645, text: 'над-якорем' },
      { x: 60, y: 636, text: 'ЯКОРЬ-1' },
      { x: 200, y: 552, text: 'хвост-1' },
      { x: 60, y: 534, text: 'ЯКОРЬ-2' }
    ])
    const blocks = splitIntoBlocks(lines, l => l.cells.some(c => c.text.startsWith('ЯКОРЬ')))
    expect(blocks).toHaveLength(2)
    const texts = (b: typeof blocks[number]): string[] => b.flatMap(l => l.cells.map(c => c.text))
    expect(texts(blocks[0]!)).toEqual(['над-якорем', 'ЯКОРЬ-1', 'хвост-1'])
    expect(texts(blocks[1]!)).toEqual(['ЯКОРЬ-2'])
  })
})

describe('МБАНК: выписка в PDF', () => {
  it('опознаётся и разбирается в операции', () => {
    expect(isMbankPdf(mbank())).toBe(true)
    expect(detectManualPdfFormat(mbank())).toBe('mbank-pdf')
    const parsed = parseMbankPdf(mbank())
    expect(parsed.header).toMatchObject({ account: '1000000000000001', currency: 'KGS' })
    expect(parsed.rows).toHaveLength(2)
  })

  it('собирает сумму, РАЗОРВАННУЮ переносом внутри ячейки', () => {
    // ⚠ Ровно то, ради чего написан слой раскладки: в потоке текста это '30,000.0' и '0'.
    const { items } = normalizeMbankPdfRows(parseMbankPdf(mbank()), { account: '' })
    const credit = items.find(i => i.direction === 'credit')
    expect(credit?.amount).toBe(30000)
  })

  it('«Оборот Дт» — РАСХОД, вопреки назначению «Пополнение счета»', () => {
    // Направление выведено сведением сальдо, а не чтением назначения (см. преамбулу модуля).
    const { items } = normalizeMbankPdfRows(parseMbankPdf(mbank()), { account: '' })
    const debit = items.find(i => i.purpose.includes('Пополнение счета'))
    expect(debit?.direction).toBe('debit')
    expect(debit?.amount).toBe(3109.3)
  })

  it('сальдо СХОДИТСЯ — это и есть проверка, что колонки не разъехались', () => {
    const parsed = parseMbankPdf(mbank())
    const { items } = normalizeMbankPdfRows(parsed, { account: '' })
    expect(mbankBalanceCheck(parsed.header, items)).toEqual({
      expected: 34577.92,
      actual: 34577.92,
      ok: true
    })
  })

  it('реквизиты контрагента собраны целиком, включая строку, стоящую ВЫШЕ якоря', () => {
    const { items } = normalizeMbankPdfRows(parseMbankPdf(mbank()), { account: '' })
    const first = items[0]!
    expect(first.counterparty.name).toBe('Иванов Иван Иванович')
    expect(first.counterparty.account).toBe('1000000000000002')
    expect(first.counterparty.unp).toBe('11111111111111')
  })

  it('в ключе дедупа есть ДАТА — номер документа у банка сквозной', () => {
    const { items } = normalizeMbankPdfRows(parseMbankPdf(mbank()), { account: '' })
    expect(items[0]!.docId).toBe('722|2026-06-04')
    expect(items[0]!.docNum).toBe('722')
  })

  it('«сверять было нечем» НЕ выдаётся за «сошлось»', () => {
    const header = { account: '', currency: 'KGS', openingBalance: Number.NaN, closingBalance: 1 }
    expect(mbankBalanceCheck(header, [])).toBeNull()
  })
})

describe('Бакай Банк: выписка в PDF', () => {
  it('опознаётся и разбирается в операции', () => {
    expect(isBakaiPdf(bakai())).toBe(true)
    expect(detectManualPdfFormat(bakai())).toBe('bakai-pdf')
    const parsed = parseBakaiPdf(bakai())
    expect(parsed.header).toMatchObject({ account: '1240020000000001', currency: 'RUB' })
    expect(parsed.rows).toHaveLength(2)
  })

  it('направление берётся из КОЛОНОК банка', () => {
    const { items } = normalizeBakaiPdfRows(parseBakaiPdf(bakai()), { account: '' })
    expect(items.map(i => [i.direction, i.amount])).toEqual([
      ['credit', 434000],
      ['debit', 134000]
    ])
  })

  it('служебная строка «Остаток на конец» не становится ни операцией, ни частью назначения', () => {
    // Она стоит ВНУТРИ записи и в колонке сумм. Числом её не примут (там буквы), поэтому лишней
    // операции не выйдет — но назначение забирает ВСЕ нечисловые ячейки правее детализации, и без
    // явного отбрасывания промежуточный остаток уехал бы в текст платежа, в карточку клиента.
    // ⚠ Проверяется именно это: мутация «убрать фильтр» иначе проходит зелёной (замерено).
    const { items, nonPayment, unreadable } = normalizeBakaiPdfRows(parseBakaiPdf(bakai()), { account: '' })
    expect(items).toHaveLength(2)
    expect(nonPayment).toBe(0)
    expect(unreadable).toBe(0)
    for (const item of items) expect(item.purpose).not.toContain('Остаток на конец')
  })

  it('обороты из подвала СХОДЯТСЯ, хотя оба итога — один обрывок текста', () => {
    const parsed = parseBakaiPdf(bakai())
    const { items } = normalizeBakaiPdfRows(parsed, { account: '' })
    const check = bakaiTurnoverCheck(parsed.header, items)
    expect(check?.ok).toBe(true)
    expect(check?.debit).toEqual({ expected: 134000, actual: 134000 })
  })

  it('хвост назначения не съеден колонкой суммы, а сумма не съедена назначением', () => {
    const { items } = normalizeBakaiPdfRows(parseBakaiPdf(bakai()), { account: '' })
    expect(items[0]!.purpose).toContain('за услуги')
    expect(items[0]!.amount).toBe(434000)
  })

  it('счёт контрагента и номер документа разведены по длине числа', () => {
    const { items } = normalizeBakaiPdfRows(parseBakaiPdf(bakai()), { account: '' })
    expect(items[0]!.counterparty.account).toBe('1241110000000002')
    expect(items[0]!.counterparty.name).toBe('ООО "Первый"')
    expect(items[0]!.docId).toBe('1753919|2026-06-03')
  })

  it('УНП не выдумывается из счёта', () => {
    const { items } = normalizeBakaiPdfRows(parseBakaiPdf(bakai()), { account: '' })
    expect(items[0]!.counterparty.unp).toBe('')
  })
})

describe('parseManualPdf: выбор банка', () => {
  it('незнакомый PDF — отказ с объяснением, а не пустой разбор', () => {
    const pages: PdfPage[] = [{ width: 100, height: 100, items: [{ x: 1, y: 1, text: 'чужой документ' }] }]
    expect(detectManualPdfFormat(pages)).toBe('unknown')
    expect(() => parseManualPdf(pages, { account: '' })).toThrow(/Неизвестный формат PDF/)
  })

  it('оба банка доезжают до общей точки разбора', () => {
    expect(parseManualPdf(mbank(), { account: '' }).items).toHaveLength(2)
    expect(parseManualPdf(bakai(), { account: '' }).items).toHaveLength(2)
  })
})
