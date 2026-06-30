import { describe, expect, it } from 'vitest'
import { alfaDateToIso, alfaStatementErrors, normalizeAlfaRow, normalizeAlfaStatement } from '~/utils/alfaStatement'
import type { AlfaStatementRow } from '~/utils/alfaStatement'

function row(over: Partial<AlfaStatementRow> = {}): AlfaStatementRow {
  return {
    number: 'BY80ALFA30121122220090270000',
    operType: 'C',
    operCodeName: 'Зачисление',
    operDate: '26.06.2026',
    acceptDate: '2026-06-26T14:00:00.000',
    docId: '100231',
    docNum: '541',
    amount: 1840.5,
    currIso: 'BYN',
    purpose: 'Оплата по счёту №541',
    corrName: 'ООО «Ромашка»',
    corrUnp: '191234567',
    corrNumber: 'BY24X',
    corrBic: 'ALFABY2X',
    corrBank: 'ОАО «Альфа-Банк»',
    ...over
  }
}

describe('alfaDateToIso', () => {
  it('converts DD.MM.YYYY to ISO date', () => {
    expect(alfaDateToIso('26.06.2026')).toBe('2026-06-26')
  })
  it('passes ISO-ish input through and trims', () => {
    expect(alfaDateToIso(' 2026-06-26T14:00:00.000 ')).toBe('2026-06-26T14:00:00.000')
  })
  it('returns empty string for empty input', () => {
    expect(alfaDateToIso(undefined)).toBe('')
  })
})

describe('normalizeAlfaRow', () => {
  it('maps a credit row into our StatementItem', () => {
    const item = normalizeAlfaRow(row())
    expect(item).toMatchObject({
      account: 'BY80ALFA30121122220090270000',
      docId: '100231',
      docNum: '541',
      direction: 'credit',
      amount: 1840.5,
      currency: 'BYN',
      purpose: 'Оплата по счёту №541',
      acceptDate: '2026-06-26T14:00:00.000',
      operDate: '2026-06-26',
      operCodeName: 'Зачисление'
    })
    expect(item.counterparty).toMatchObject({
      name: 'ООО «Ромашка»', unp: '191234567', account: 'BY24X', bank: 'ОАО «Альфа-Банк»', bic: 'ALFABY2X'
    })
  })

  it('maps operType D to debit', () => {
    expect(normalizeAlfaRow(row({ operType: 'D' })).direction).toBe('debit')
  })

  it('coerces a string amount and omits empty optional fields', () => {
    const item = normalizeAlfaRow(row({ amount: undefined, docNum: '  ', corrBank: '', operDate: undefined }))
    expect(item.amount).toBe(0)
    expect(item.docNum).toBeUndefined()
    expect(item.counterparty.bank).toBeUndefined()
    expect(item.operDate).toBeUndefined()
  })

  it('parses a numeric string amount and falls back to 0 on garbage (no NaN)', () => {
    expect(normalizeAlfaRow(row({ amount: '1234.56' as unknown as number })).amount).toBe(1234.56)
    expect(normalizeAlfaRow(row({ amount: 'not_a_number' as unknown as number })).amount).toBe(0)
  })

  it('trims whitespace in string fields', () => {
    const item = normalizeAlfaRow(row({ number: '  BY80ACC  ', purpose: ' pay ', corrName: ' ООО ', corrUnp: ' 19 ' }))
    expect(item.account).toBe('BY80ACC')
    expect(item.purpose).toBe('pay')
    expect(item.counterparty.name).toBe('ООО')
    expect(item.counterparty.unp).toBe('19')
  })

  it('maps an unknown operType to debit (end-to-end through normalizeAlfaRow)', () => {
    expect(normalizeAlfaRow(row({ operType: 'X' })).direction).toBe('debit')
  })
})

describe('alfaStatementErrors', () => {
  it('returns the errors array, or empty when absent', () => {
    expect(alfaStatementErrors({ errors: [{ number: 'BY1', message: 'нет счёта' }] }))
      .toEqual([{ number: 'BY1', message: 'нет счёта' }])
    expect(alfaStatementErrors({ page: [] })).toEqual([])
  })
})

describe('normalizeAlfaStatement', () => {
  it('maps the page array', () => {
    const items = normalizeAlfaStatement({ page: [row({ docId: 'a' }), row({ docId: 'b', operType: 'D' })] })
    expect(items.map(i => [i.docId, i.direction])).toEqual([['a', 'credit'], ['b', 'debit']])
  })
  it('returns an empty list when there is no page', () => {
    expect(normalizeAlfaStatement({})).toEqual([])
  })
})
