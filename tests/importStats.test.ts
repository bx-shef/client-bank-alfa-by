import { describe, expect, it } from 'vitest'
import {
  computeImportStats, currencyTotal, dayBucketsForCurrency, operationDay
} from '~/utils/importStats'
import type { StatementItem } from '~/types/statement'

function item(partial: Partial<StatementItem> = {}): StatementItem {
  return {
    account: 'A', docId: 'd1', direction: 'credit', amount: 100, currency: 'BYN',
    purpose: 'оплата', counterparty: { name: 'ООО Ромашка', unp: '1', account: 'BY1' },
    acceptDate: '2026-07-01T00:00:00.000Z', ...partial
  }
}

describe('operationDay', () => {
  it('prefers operDate, falls back to acceptDate, truncates to YYYY-MM-DD', () => {
    expect(operationDay(item({ operDate: '2026-07-05T12:00:00Z', acceptDate: '2026-07-01T00:00:00Z' }))).toBe('2026-07-05')
    expect(operationDay(item({ operDate: undefined, acceptDate: '2026-07-01T09:30:00Z' }))).toBe('2026-07-01')
  })
  it('returns empty when no usable ISO date is present', () => {
    expect(operationDay(item({ operDate: '', acceptDate: '' }))).toBe('')
    expect(operationDay(item({ operDate: 'не дата', acceptDate: 'нет' }))).toBe('')
  })
})

describe('computeImportStats', () => {
  it('is safe on an empty list', () => {
    expect(computeImportStats([])).toEqual({ total: 0, byCurrency: [], dominantCurrency: null, byDay: [] })
  })

  it('splits income/expense totals and counts per currency', () => {
    const stats = computeImportStats([
      item({ docId: '1', direction: 'credit', amount: 100, currency: 'BYN' }),
      item({ docId: '2', direction: 'credit', amount: 50, currency: 'BYN' }),
      item({ docId: '3', direction: 'debit', amount: 30, currency: 'BYN' }),
      item({ docId: '4', direction: 'credit', amount: 200, currency: 'RUB' })
    ])
    expect(stats.total).toBe(4)
    expect(stats.byCurrency).toEqual([
      { currency: 'BYN', income: 150, expense: 30, incomeCount: 2, expenseCount: 1 },
      { currency: 'RUB', income: 200, expense: 0, incomeCount: 1, expenseCount: 0 }
    ])
  })

  it('sorts byCurrency by currency code even when inserted in reverse order', () => {
    const stats = computeImportStats([
      item({ docId: '1', currency: 'RUB' }), item({ docId: '2', currency: 'BYN' }), item({ docId: '3', currency: 'USD' })
    ])
    expect(stats.byCurrency.map(c => c.currency)).toEqual(['BYN', 'RUB', 'USD'])
  })

  it('populates byCurrency but leaves byDay empty when the dominant currency has no usable day', () => {
    const stats = computeImportStats([
      item({ docId: '1', currency: 'BYN', operDate: '', acceptDate: '' })
    ])
    expect(stats.dominantCurrency).toBe('BYN')
    expect(stats.byCurrency).toHaveLength(1)
    expect(stats.byDay).toEqual([])
  })

  it('buckets a blank currency under "" without merging into a real currency', () => {
    const stats = computeImportStats([
      item({ docId: '1', currency: '', amount: 10, direction: 'credit' }),
      item({ docId: '2', currency: 'BYN', amount: 20, direction: 'credit' })
    ])
    expect(stats.byCurrency.map(c => c.currency)).toEqual(['', 'BYN'])
    expect(currencyTotal(stats, '').income).toBe(10)
  })

  it('aggregates an all-debit currency (income stays 0)', () => {
    const stats = computeImportStats([
      item({ docId: '1', currency: 'BYN', direction: 'debit', amount: 30 }),
      item({ docId: '2', currency: 'BYN', direction: 'debit', amount: 20 })
    ])
    expect(stats.byCurrency[0]).toEqual({ currency: 'BYN', income: 0, expense: 50, incomeCount: 0, expenseCount: 2 })
  })

  it('picks the dominant currency by op-count (BYN has more ops than RUB)', () => {
    const stats = computeImportStats([
      item({ docId: '1', currency: 'BYN' }), item({ docId: '2', currency: 'BYN' }),
      item({ docId: '3', currency: 'RUB' })
    ])
    expect(stats.dominantCurrency).toBe('BYN')
  })

  it('breaks a dominant-currency tie by the smallest currency code (deterministic)', () => {
    const stats = computeImportStats([
      item({ docId: '1', currency: 'USD' }), item({ docId: '2', currency: 'EUR' })
    ])
    expect(stats.dominantCurrency).toBe('EUR') // 1 op each → lexicographically smallest
  })

  it('builds the by-day series for the dominant currency, sorted ascending', () => {
    const stats = computeImportStats([
      item({ docId: '1', direction: 'credit', amount: 100, currency: 'BYN', operDate: '2026-07-02T00:00:00Z' }),
      item({ docId: '2', direction: 'debit', amount: 40, currency: 'BYN', operDate: '2026-07-02T00:00:00Z' }),
      item({ docId: '3', direction: 'credit', amount: 60, currency: 'BYN', operDate: '2026-07-01T00:00:00Z' }),
      item({ docId: '4', direction: 'credit', amount: 999, currency: 'RUB', operDate: '2026-07-01T00:00:00Z' })
    ])
    expect(stats.dominantCurrency).toBe('BYN')
    expect(stats.byDay).toEqual([
      { date: '2026-07-01', income: 60, expense: 0 },
      { date: '2026-07-02', income: 100, expense: 40 }
    ])
  })

  it('coerces a negative/NaN amount to 0 (a bad row cannot poison a total)', () => {
    const stats = computeImportStats([
      item({ docId: '1', direction: 'credit', amount: Number.NaN, currency: 'BYN' }),
      item({ docId: '2', direction: 'credit', amount: -5, currency: 'BYN' }),
      item({ docId: '3', direction: 'credit', amount: 10, currency: 'BYN' })
    ])
    expect(stats.byCurrency[0]).toMatchObject({ income: 10, incomeCount: 3 })
  })

  it('rounds sums to 2 decimals after accumulating (no float drift)', () => {
    const stats = computeImportStats([
      item({ docId: '1', direction: 'credit', amount: 0.1, currency: 'BYN' }),
      item({ docId: '2', direction: 'credit', amount: 0.2, currency: 'BYN' })
    ])
    expect(stats.byCurrency[0].income).toBe(0.3) // not 0.30000000000000004
  })
})

describe('dayBucketsForCurrency', () => {
  it('ignores other currencies and rows without a usable day', () => {
    const buckets = dayBucketsForCurrency([
      item({ docId: '1', direction: 'credit', amount: 100, currency: 'BYN', operDate: '2026-07-01T00:00:00Z' }),
      item({ docId: '2', direction: 'credit', amount: 999, currency: 'RUB', operDate: '2026-07-01T00:00:00Z' }),
      item({ docId: '3', direction: 'debit', amount: 5, currency: 'BYN', operDate: '', acceptDate: '' })
    ], 'BYN')
    expect(buckets).toEqual([{ date: '2026-07-01', income: 100, expense: 0 }])
  })
})
