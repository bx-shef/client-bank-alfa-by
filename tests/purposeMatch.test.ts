import { describe, expect, it } from 'vitest'
import type { RecognitionRule } from '~/utils/purposeMatch'
import { recognizeIdentifiers } from '~/utils/purposeMatch'

// Pure identifier recognition from a payment purpose (#109, PROCESSING.md §4).
// The engine is config-driven — these tests supply their own phrase rules (real
// per-portal phrases arrive with live statements). Covers: extraction after a
// phrase, separator variants, case-insensitivity, multiple rules/matches, the
// "letters must not intervene" guard, composite numbers, and dedup.

const invoiceRule: RecognitionRule = { phrases: ['счёт', 'инвойс'], kind: 'invoice-number' }
const dealRule: RecognitionRule = { phrases: ['сделка', 'заказ'], kind: 'deal-id' }

describe('recognizeIdentifiers', () => {
  it('extracts the number that follows a trigger phrase', () => {
    expect(recognizeIdentifiers('Оплата по счёт 123', [invoiceRule]))
      .toEqual([{ kind: 'invoice-number', value: '123' }])
  })

  it('tolerates separators between phrase and number (: № # . -, spaces)', () => {
    for (const sep of [' № ', ': ', ' #', '. ', ' - ', '№']) {
      expect(recognizeIdentifiers(`счёт${sep}77 за услуги`, [invoiceRule]))
        .toEqual([{ kind: 'invoice-number', value: '77' }])
    }
  })

  it('is case-insensitive (incl. Cyrillic)', () => {
    expect(recognizeIdentifiers('СЧЁТ 45', [invoiceRule]))
      .toEqual([{ kind: 'invoice-number', value: '45' }])
  })

  it('applies several rules and returns all matches', () => {
    const res = recognizeIdentifiers('Оплата по счёт 10 к заказ 20', [invoiceRule, dealRule])
    expect(res).toEqual([
      { kind: 'invoice-number', value: '10' },
      { kind: 'deal-id', value: '20' }
    ])
  })

  it('does NOT grab a number when letters intervene (счёт-фактура 12)', () => {
    expect(recognizeIdentifiers('счёт-фактура 12', [invoiceRule])).toEqual([])
  })

  it('does NOT match the phrase inside a longer word (левая граница слова)', () => {
    // «расчёту» contains «счёт» as a substring — must not trigger.
    expect(recognizeIdentifiers('Оплата согласно расчёту 100', [invoiceRule])).toEqual([])
    expect(recognizeIdentifiers('расчётный счётчик 5', [invoiceRule])).toEqual([])
  })

  it('still matches a standalone phrase after a word (по счёт 100)', () => {
    expect(recognizeIdentifiers('оплата по счёт 100', [invoiceRule]))
      .toEqual([{ kind: 'invoice-number', value: '100' }])
  })

  it('matches when the number directly adjoins the phrase (no separator)', () => {
    expect(recognizeIdentifiers('счёт77 оплата', [invoiceRule]))
      .toEqual([{ kind: 'invoice-number', value: '77' }])
  })

  it('does NOT normalize ё/е — phrase must match the configured spelling', () => {
    expect(recognizeIdentifiers('оплата по счет 5', [invoiceRule])).toEqual([])
  })

  it('dedups across different phrases of one rule pointing at the same value', () => {
    const rule: RecognitionRule = { phrases: ['счёт', 'инвойс'], kind: 'invoice-number' }
    expect(recognizeIdentifiers('счёт 5 инвойс 5', [rule]))
      .toEqual([{ kind: 'invoice-number', value: '5' }])
  })

  it('skips an absurdly long value (> MAX_ID_CHARS)', () => {
    const huge = '9'.repeat(80)
    expect(recognizeIdentifiers(`счёт ${huge}`, [invoiceRule])).toEqual([])
  })

  it('keeps composite numbers as a single value (123/45, 2024-7)', () => {
    expect(recognizeIdentifiers('инвойс 123/45', [invoiceRule]))
      .toEqual([{ kind: 'invoice-number', value: '123/45' }])
    expect(recognizeIdentifiers('инвойс 2024-7', [invoiceRule]))
      .toEqual([{ kind: 'invoice-number', value: '2024-7' }])
  })

  it('preserves leading zeros (value stays a string)', () => {
    expect(recognizeIdentifiers('счёт 007', [invoiceRule]))
      .toEqual([{ kind: 'invoice-number', value: '007' }])
  })

  it('dedups the same kind+value, keeps distinct values', () => {
    expect(recognizeIdentifiers('счёт 5 и ещё счёт 5', [invoiceRule]))
      .toEqual([{ kind: 'invoice-number', value: '5' }])
    expect(recognizeIdentifiers('счёт 5, счёт 6', [invoiceRule]))
      .toEqual([
        { kind: 'invoice-number', value: '5' },
        { kind: 'invoice-number', value: '6' }
      ])
  })

  it('returns [] when no phrase matches or no number follows', () => {
    expect(recognizeIdentifiers('оплата без номера', [invoiceRule])).toEqual([])
    expect(recognizeIdentifiers('счёт за услуги', [invoiceRule])).toEqual([])
    expect(recognizeIdentifiers('123 без фразы', [invoiceRule])).toEqual([])
  })

  it('ignores empty/blank phrases and empty rule sets', () => {
    expect(recognizeIdentifiers('счёт 1', [{ phrases: ['', '  '], kind: 'invoice-id' }])).toEqual([])
    expect(recognizeIdentifiers('счёт 1', [])).toEqual([])
  })

  it('treats a regex-special phrase literally (no injection)', () => {
    const rule: RecognitionRule = { phrases: ['счёт (осн.)'], kind: 'invoice-number' }
    expect(recognizeIdentifiers('счёт (осн.) 88', [rule]))
      .toEqual([{ kind: 'invoice-number', value: '88' }])
  })
})
