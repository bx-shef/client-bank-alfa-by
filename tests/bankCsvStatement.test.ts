import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { detectStatementEncoding } from '~/utils/statementEncoding'
import { detectManualFormat, parseManualStatement } from '~/utils/manualImport'
import { parseAlfaCsv, normalizeAlfaCsvRows, isAlfaCsv } from '~/utils/alfaCsvStatement'
import { parsePriorCsv, normalizePriorCsvRows, isPriorCsv, priorCsvDirection, isoFromDotted } from '~/utils/priorCsvStatement'
import { parseBankAmount } from '~/utils/money'

// CSV-выгрузки двух банков (#707). Фикстуры СИНТЕТИЧЕСКИЕ — см. гард приватности ниже; структура
// и все проверяемые здесь свойства замерены на боевых файлах владельца, сами файлы в репозиторий
// не попадают.

const DIR = join(import.meta.dirname, 'fixtures', 'bank-csv')

function text(name: string): string {
  const buf = readFileSync(join(DIR, name))
  return new TextDecoder(detectStatementEncoding(buf)).decode(buf)
}

// ⚠ Пустой `account` — «бери счёт из файла»: у выписки он в шапке, и подстановка своего
// значения здесь проверяла бы не тот путь, каким идёт ручная загрузка.
const CTX = { account: '' }

describe('фикстуры CSV — синтетика, а не выписки клиента', () => {
  /**
   * ⚠ Репозиторий ПУБЛИЧНЫЙ, а принесённые файлы несли реальные ФИО, номер паспорта, УНП, счета и
   * названия контрагентов. Гард смотрит на сами файлы, а не на намерение: строка, попавшая в
   * фикстуру копипастой из боевой выгрузки, обязана уронить набор здесь, а не всплыть в выдаче.
   * ⚠ `\b` с кириллицей в JS не работает вовсе (замерено на #700: маска молча не находила ничего
   * и прошла бы зелёной над утечкой), поэтому границы слов здесь нет.
   */
  it('в фикстурах нет реальных идентификаторов', () => {
    const forbidden = [/БЕЛПРОФСЕРТ/i, /ШЕВЧИК/i, /ПАСПОРТ/i, /АНКРОН/i, /МЕРИДА/i, /КЛЕРМОНТ/i, /ТАПАС/i]
    for (const name of readdirSync(DIR)) {
      const body = text(name)
      for (const mask of forbidden) {
        expect(mask.test(body), `${name} содержит ${mask}`).toBe(false)
      }
      // Счета и УНП — демонстрационные: в номере счёта стоит DEMO, УНП начинается с круглого числа.
      for (const acc of body.match(/BY\d{2}[A-Z]{4}[0-9A-Z]{16,20}/g) ?? []) {
        expect(acc, `${name}: счёт ${acc} не помечен как демонстрационный`).toMatch(/DEMO/)
      }
    }
  })
})

describe('CSV Приорбанка', () => {
  it('опознаётся как свой формат и не путается с соседями', () => {
    const body = text('prior-byn.csv')
    expect(detectManualFormat(body)).toBe('prior-csv')
    expect(isPriorCsv(body)).toBe(true)
    // ⚠ Разделитель у двух CSV общий, поэтому важно, что чужой файл СВОИМ не считается.
    expect(isAlfaCsv(body)).toBe(false)
  })

  it('читает шапку, направления и суммы с пробелом тысяч', () => {
    const parsed = parsePriorCsv(text('prior-byn.csv'))
    expect(parsed.account).toBe('BY16DEMO34120000000000006001')
    expect(parsed.currency).toBe('BYN')

    const { items, nonPayment, unreadable } = normalizePriorCsvRows(parsed, CTX)
    expect(unreadable).toBe(0)
    // Строка банка без движения средств (обе колонки нулевые) — не платёж, но СЧИТАЕТСЯ.
    expect(nonPayment).toBe(1)
    expect(items).toHaveLength(4)

    const credits = items.filter(i => i.direction === 'credit')
    const debits = items.filter(i => i.direction === 'debit')
    expect(credits.map(i => i.amount)).toEqual([530, 1800])
    expect(debits.map(i => i.amount)).toEqual([250.78, 75])
    expect(items.every(i => i.currency === 'BYN')).toBe(true)
  })

  it('счёт контрагента приходит с пробелами и сохраняется БЕЗ них', () => {
    // ⚠ Несущее: «Исключения» сравнивают счёт ТОЧНО, и пробелы сделали бы правило админа мёртвым.
    const raw = text('prior-byn.csv')
    expect(raw, 'фикстура обязана нести счёт в том виде, в каком его пишет банк').toMatch(/BY13 DEMO3012 /)
    const { items } = normalizePriorCsvRows(parsePriorCsv(raw), CTX)
    expect(items.every(i => !/\s/.test(i.counterparty.account))).toBe(true)
    expect(items[0]!.counterparty.account).toBe('BY13DEMO30120000000000003000')
  })

  it('ключ дедупа несёт дату, а не только номер документа', () => {
    const { items } = normalizePriorCsvRows(parsePriorCsv(text('prior-byn.csv')), CTX)
    expect(items[0]!.docId).toBe('2026-08-05|2584')
    expect(new Set(items.map(i => i.docId)).size).toBe(items.length)
  })

  it('имя контрагента и УНП есть — в отличие от звёздочного формата', () => {
    const { items } = normalizePriorCsvRows(parsePriorCsv(text('prior-byn.csv')), CTX)
    expect(items[0]!.counterparty.name).toBe('ООО "ДЕМОКЛИЕНТ"')
    expect(items[0]!.counterparty.unp).toBe('190000000')
    expect(items[0]!.counterparty.bic).toBe('DEMOBY2X')
  })

  it('расхождение оборотов — отказ, а не частичный импорт', () => {
    // Выкидываем одну операцию: файл остаётся синтаксически корректным, обороты перестают сходиться.
    const body = text('prior-byn.csv').split('\n').filter(l => !l.startsWith('13.08.2026')).join('\n')
    expect(() => parsePriorCsv(body)).toThrow(/неполная/i)
  })

  it('пропавшая строка оборотов — тоже отказ (при обрыве теряется именно хвост)', () => {
    const body = text('prior-byn.csv').split('\n').filter(l => !l.startsWith('Обороты')).join('\n')
    expect(() => parsePriorCsv(body)).toThrow(/Обороты/)
  })

  it('пропавшая колонка названа по имени, а не молча заменена соседней', () => {
    const body = text('prior-byn.csv').replace('Номинал.Кредит;', 'Номинал.Приход;')
    expect(() => parsePriorCsv(body)).toThrow(/Номинал\.Кредит/)
  })

  it('направление требует ровно одной ненулевой стороны', () => {
    expect(priorCsvDirection(10, 0)).toBe('debit')
    expect(priorCsvDirection(0, 10)).toBe('credit')
    expect(priorCsvDirection(0, 0)).toBe(null)
    // Обе стороны — такого банк не пишет: формат сменился, гадать нельзя.
    expect(priorCsvDirection(10, 10)).toBe(null)
    expect(priorCsvDirection(Number.NaN, 10)).toBe(null)
  })

  it('дата разбирается строго и отвергает несуществующую', () => {
    expect(isoFromDotted('05.08.2026')).toBe('2026-08-05')
    expect(isoFromDotted('31.02.2026')).toBe('')
    expect(isoFromDotted('5.8.2026')).toBe('')
    expect(isoFromDotted('')).toBe('')
  })
})

describe('CSV Альфа-Банка', () => {
  it('опознаётся как свой формат и не путается с соседями', () => {
    const body = text('alfa-byn.csv')
    expect(detectManualFormat(body)).toBe('alfa-csv')
    expect(isAlfaCsv(body)).toBe(true)
    expect(isPriorCsv(body)).toBe(false)
  })

  it('направление берётся из СЕКЦИИ, а не из строки', () => {
    const parsed = parseAlfaCsv(text('alfa-byn.csv'))
    expect(parsed.account).toBe('BY09DEMO30100000000000270000')
    expect(parsed.currencyCode).toBe('933')

    const { items, unreadable, nonPayment } = normalizeAlfaCsvRows(parsed, CTX)
    expect({ unreadable, nonPayment }).toEqual({ unreadable: 0, nonPayment: 0 })
    expect(items.map(i => [i.direction, i.amount])).toEqual([
      ['debit', 10000],
      ['debit', 8.7],
      ['credit', 110],
      ['credit', 4580]
    ])
    expect(items.every(i => i.currency === 'BYN')).toBe(true)
  })

  /**
   * ⚠ Строка «ИТОГО ОБОРОТ ПО ДЕБЕТУ» СОДЕРЖИТ слово «ДЕБЕТ», поэтому итог проверяется РАНЬШЕ
   * маркера секции и ЗАКРЫВАЕТ её.
   *
   * ⚠ Первая редакция этого теста проверяла, что кредитовый блок не уехал в расходы, — и была
   * ФИКТИВНОЙ: замерено мутацией, что перестановка проверок оставляет её зелёной. В самом файле
   * сразу за дебетовым итогом стоит маркер «КРЕДИТ», который всё равно переустановил бы секцию,
   * то есть на этой раскладке ошибка не проявляется вовсе. Настоящее следствие другое: после
   * итога секции НЕТ, и операция под ним обязана получить отказ, а не молча стать расходом.
   */
  it('итог ЗАКРЫВАЕТ секцию, а не переоткрывает её', () => {
    const lines = text('alfa-byn.csv').split('\n')
    const at = lines.findIndex(l => l.startsWith('ИТОГО ОБОРОТ ПО ДЕБЕТУ'))
    expect(at).toBeGreaterThan(0)
    // Операция сразу ПОД итогом и БЕЗ маркера: направление взять неоткуда.
    lines.splice(at + 1, 0, '12.09.2026;1;9999;DEMOBY2X ;190000001;BY51DEMO30120000000000000933;;1.00;ООО "ДЕМОПАРТНЕР";Строка без блока;')
    expect(() => parseAlfaCsv(lines.join('\n'))).toThrow(/вне блоков/i)
  })

  it('операция вне секции — отказ разбора, а не догадка о направлении', () => {
    const body = text('alfa-byn.csv').split('\n').filter(l => !/ ДЕБЕТ; ; ;/.test(l)).join('\n')
    expect(() => parseAlfaCsv(body)).toThrow(/вне блоков/i)
  })

  it('расхождение оборотов — отказ', () => {
    const body = text('alfa-byn.csv').split('\n').filter(l => !l.startsWith('01.09.2026')).join('\n')
    expect(() => parseAlfaCsv(body)).toThrow(/неполная/i)
  })

  it('ключ дедупа несёт дату', () => {
    const { items } = normalizeAlfaCsvRows(parseAlfaCsv(text('alfa-byn.csv')), CTX)
    expect(items[0]!.docId).toBe('2026-09-11|2312')
    expect(new Set(items.map(i => i.docId)).size).toBe(items.length)
  })
})

describe('суммы двух банков читаются одним правилом', () => {
  /**
   * ⚠ Разделители РАЗНЫЕ и это замерено: Приорбанк пишет `1 800,00`, Альфа — `10 000.00`.
   * Правило одно (`parseBankAmount`), потому что две копии разъехались бы молча.
   */
  it('принимает обе формы и отвергает мусор', () => {
    expect(parseBankAmount('1 800,00')).toBe(1800)
    expect(parseBankAmount('10 000.00')).toBe(10000)
    expect(parseBankAmount('18,28')).toBe(18.28)
    expect(parseBankAmount('0,00')).toBe(0)
    for (const bad of ['1e3', '18,28abc', '--18,28', '18..28', '', 'нет']) {
      expect(Number.isNaN(parseBankAmount(bad)), bad).toBe(true)
    }
  })
})

describe('оба формата доезжают через общую точку входа', () => {
  it('parseManualStatement разбирает их без отдельного вызова парсера', () => {
    const prior = parseManualStatement(text('prior-byn.csv'), CTX)
    expect(prior.items).toHaveLength(4)
    expect(prior.nonPayment).toBe(1)

    const alfa = parseManualStatement(text('alfa-byn.csv'), CTX)
    expect(alfa.items).toHaveLength(4)
  })

  it('кодировка определяется, а не предполагается', () => {
    for (const name of readdirSync(DIR)) {
      const buf = readFileSync(join(DIR, name))
      expect(detectStatementEncoding(buf), name).toBe('windows-1251')
    }
  })
})
