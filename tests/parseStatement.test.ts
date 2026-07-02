import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { StatementItem } from '~/types/statement'
import { parseClientBankText } from '~/utils/clientBankText'
import { normalizeManualStatement } from '~/utils/manualImport'
import { formatItems, formatParsed, maskAccount, truncText } from '../scripts/lib/statement-format.ts'

describe('maskAccount', () => {
  it('keeps the last 4 of a long account', () => {
    expect(maskAccount('BY13ALFA12340000933')).toBe('****0933')
  })
  it('fully masks short values so nothing leaks', () => {
    expect(maskAccount('1234')).toBe('****')
    expect(maskAccount('12')).toBe('****')
  })
  it('shows ? for an empty account', () => {
    expect(maskAccount('')).toBe('?')
  })
})

describe('truncText', () => {
  it('truncates long strings', () => {
    expect(truncText('abcdef', 3)).toBe('abc…')
  })
  it('passes short/empty/undefined through', () => {
    expect(truncText('ab', 3)).toBe('ab')
    expect(truncText(undefined, 3)).toBe('')
  })
})

describe('formatParsed (integration with the canonical parser + a CP1251 fixture)', () => {
  const text = new TextDecoder('windows-1251').decode(
    readFileSync('tests/fixtures/client-bank/demo-prior-byn.txt')
  )
  const lines = formatParsed(parseClientBankText(text))

  it('renders a GENERAL line with the account masked (never the full number)', () => {
    const general = lines.find(l => l.startsWith('GENERAL:'))
    expect(general).toBeDefined()
    expect(general).toContain('****0933')
    expect(general).not.toMatch(/\d{10,}/) // no long raw account number leaked
  })
  it('renders both statement sections', () => {
    expect(lines.some(l => l.includes('[IN_PARAM]'))).toBe(true)
    expect(lines.some(l => l.includes('[OUT_PARAM]'))).toBe(true)
  })
})

describe('formatItems (unified normalized StatementItem[] view)', () => {
  const mkItem = (over: Partial<StatementItem>): StatementItem => ({
    account: 'BY13ALFA12340000933',
    docId: 'DOC1',
    direction: 'debit',
    amount: 50,
    currency: 'BYN',
    purpose: 'оплата',
    counterparty: { name: 'ООО Ромашка', unp: '', account: 'BY99XYZ00000000999' },
    acceptDate: '2023-09-28T00:00:00.000',
    ...over
  })

  it('shows the operation count and per-currency приход/расход totals', () => {
    const lines = formatItems([
      mkItem({ direction: 'credit', amount: 100, docId: 'a' }),
      mkItem({ direction: 'debit', amount: 30, docId: 'b' })
    ])
    expect(lines[0]).toContain('операций 2')
    expect(lines.some(l => l.includes('BYN:') && l.includes('приходы 1 (+100.00)') && l.includes('расходы 1 (−30.00)'))).toBe(true)
  })

  it('masks both our account and the counterparty account (no long number leaks)', () => {
    const lines = formatItems([mkItem({})])
    const row = lines.find(l => l.startsWith('  •'))!
    expect(row).toContain('****0933') // dedup key uses our masked account
    expect(row).toContain('****0999') // counterparty masked
    expect(row).not.toMatch(/\d{10,}/)
  })

  it('separates currencies and caps the sample rows', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      mkItem({ docId: `d${i}`, currency: i % 2 ? 'USD' : 'BYN' }))
    const lines = formatItems(many, 3)
    expect(lines.some(l => l.includes('BYN:'))).toBe(true)
    expect(lines.some(l => l.includes('USD:'))).toBe(true)
    expect(lines.some(l => l.includes('… ещё 7'))).toBe(true)
  })

  it('handles an empty statement', () => {
    expect(formatItems([]).some(l => l.includes('нет операций'))).toBe(true)
  })

  it('integrates with the 1C dispatcher path (both manual formats reach StatementItem[])', () => {
    const text = new TextDecoder('windows-1251').decode(readFileSync('tests/fixtures/1c-exchange/demo-1c.txt'))
    const items = normalizeManualStatement(text, { account: '' })
    expect(items.length).toBeGreaterThan(0)
    const lines = formatItems(items)
    expect(lines[0]).toContain(`операций ${items.length}`)
  })
})
