import { describe, expect, it } from 'vitest'
import type { StatementItem } from '~/types/statement'
import { dedupKey, directionFromOperType, parseRuleLines, shouldNotifyChat, splitByDirection } from '~/utils/statement'

function makeItem(over: Partial<StatementItem> = {}): StatementItem {
  return {
    account: 'BY80ALFA30121122220090270000',
    docId: '1',
    direction: 'credit',
    amount: 100,
    currency: 'BYN',
    purpose: 'Оплата по счёту',
    counterparty: { name: 'ООО Тест', unp: '190000000', account: 'BY24X' },
    acceptDate: '2026-06-26T00:00:00.000Z',
    ...over
  }
}

describe('directionFromOperType', () => {
  it('maps C (any case, padded) to credit and everything else to debit', () => {
    expect(directionFromOperType('C')).toBe('credit')
    expect(directionFromOperType(' c ')).toBe('credit')
    expect(directionFromOperType('D')).toBe('debit')
    expect(directionFromOperType('')).toBe('debit')
    expect(directionFromOperType(undefined)).toBe('debit')
  })
})

describe('dedupKey', () => {
  it('combines account and docId', () => {
    expect(dedupKey({ account: 'BY80', docId: '42' })).toBe('BY80|42')
  })
})

describe('splitByDirection', () => {
  it('separates credits from debits preserving order', () => {
    const items = [
      makeItem({ docId: 'a', direction: 'credit' }),
      makeItem({ docId: 'b', direction: 'debit' }),
      makeItem({ docId: 'c', direction: 'credit' })
    ]
    const { credits, debits } = splitByDirection(items)
    expect(credits.map(i => i.docId)).toEqual(['a', 'c'])
    expect(debits.map(i => i.docId)).toEqual(['b'])
  })

  it('returns empty buckets for an empty array', () => {
    expect(splitByDirection([])).toEqual({ credits: [], debits: [] })
  })
})

describe('parseRuleLines', () => {
  it('splits lines, trims, drops blanks and duplicates', () => {
    expect(parseRuleLines(' BY1 \n\nBY2\nBY1\n   \n')).toEqual(['BY1', 'BY2'])
  })
  it('returns an empty array for empty/whitespace input', () => {
    expect(parseRuleLines('   \n  ')).toEqual([])
  })
})

describe('shouldNotifyChat', () => {
  it('announces credits by default and silences debits', () => {
    expect(shouldNotifyChat(makeItem({ direction: 'credit' }))).toBe(true)
    expect(shouldNotifyChat(makeItem({ direction: 'debit' }))).toBe(false)
  })

  it('can opt debits in via directions rule', () => {
    expect(shouldNotifyChat(makeItem({ direction: 'debit' }), { directions: ['credit', 'debit'] })).toBe(true)
  })

  it('respects a debit-only directions rule', () => {
    expect(shouldNotifyChat(makeItem({ direction: 'debit' }), { directions: ['debit'] })).toBe(true)
    expect(shouldNotifyChat(makeItem({ direction: 'credit' }), { directions: ['debit'] })).toBe(false)
  })

  it('applies account and purpose exclusions independently in one ruleset', () => {
    const rules = { excludeAccounts: ['BY-SILENT'], excludePurposePatterns: ['между своими'] }
    expect(shouldNotifyChat(makeItem({ account: 'BY-SILENT' }), rules)).toBe(false)
    expect(shouldNotifyChat(makeItem({ purpose: 'Перевод между своими счетами' }), rules)).toBe(false)
    expect(shouldNotifyChat(makeItem(), rules)).toBe(true)
  })

  it('silences excluded accounts (trim-insensitive)', () => {
    const item = makeItem({ account: 'BY80ACC' })
    expect(shouldNotifyChat(item, { excludeAccounts: [' BY80ACC '] })).toBe(false)
  })

  it('silences purposes matching an exclude pattern (case-insensitive)', () => {
    const item = makeItem({ purpose: 'Перевод между своими счетами' })
    expect(shouldNotifyChat(item, { excludePurposePatterns: ['между своими'] })).toBe(false)
  })

  it('ignores empty exclude patterns', () => {
    expect(shouldNotifyChat(makeItem(), { excludePurposePatterns: ['', '   '] })).toBe(true)
  })
})
