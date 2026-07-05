import { describe, expect, it } from 'vitest'
import type { MatchMatrix } from '~/utils/purposeMatch'
import { foldHomoglyphs, recognizeByMatrices } from '~/utils/purposeMatch'

// Pure matrix-based identifier recognition from a payment purpose (#109, §4).
// Masks are config (real prefixes arrive with live statements) — tests supply
// their own. Covers: digit masks, word-boundary, literal prefixes, composite
// numbers, homoglyph folding (Cyrillic↔Latin), no-space-inside, case, dedup.

const invNum = (mask: string): MatchMatrix => ({ mask, kind: 'invoice-number' })

describe('foldHomoglyphs', () => {
  it('folds Cyrillic look-alikes to Latin and back', () => {
    expect(foldHomoglyphs('ВОРС', 'latin')).toBe('BOPC')
    expect(foldHomoglyphs('BOPC', 'cyrillic')).toBe('ВОРС')
  })
  it('leaves non-homoglyph characters and digits untouched', () => {
    expect(foldHomoglyphs('Ч-1234', 'latin')).toBe('Ч-1234') // Ч has no Latin twin
    expect(foldHomoglyphs('123/45', 'cyrillic')).toBe('123/45')
  })
})

describe('recognizeByMatrices', () => {
  it('extracts a bare digit mask', () => {
    expect(recognizeByMatrices('Оплата 2001 за услуги', [invNum('dddd')]))
      .toEqual([{ kind: 'invoice-number', value: '2001' }])
  })

  it('does NOT grab a fragment of a longer number (word boundary)', () => {
    expect(recognizeByMatrices('перевод 12345', [invNum('dddd')])).toEqual([])
  })

  it('matches a literal-prefixed mask (СЧ-dddd)', () => {
    expect(recognizeByMatrices('счёт СЧ-1234 за март', [invNum('СЧ-dddd')]))
      .toEqual([{ kind: 'invoice-number', value: 'СЧ-1234' }])
  })

  it('keeps composite numbers (BOPC-ddd/dd)', () => {
    expect(recognizeByMatrices('оплата BOPC-123/45', [invNum('BOPC-ddd/dd')], 'latin'))
      .toEqual([{ kind: 'invoice-number', value: 'BOPC-123/45' }])
  })

  it('folds homoglyphs: Latin mask matches a Cyrillic-typed code (alphabet=latin)', () => {
    // purpose typed in Cyrillic «ВОРС-123», mask in Latin «BOPC-ddd»
    expect(recognizeByMatrices('оплата ВОРС-123', [invNum('BOPC-ddd')], 'latin'))
      .toEqual([{ kind: 'invoice-number', value: 'BOPC-123' }])
  })

  it('folds homoglyphs the other way (alphabet=cyrillic)', () => {
    expect(recognizeByMatrices('оплата BOPC-123', [invNum('BOPC-ddd')], 'cyrillic'))
      .toEqual([{ kind: 'invoice-number', value: 'ВОРС-123' }])
  })

  it('requires the exact literals — a space instead of the dash does not match', () => {
    expect(recognizeByMatrices('счёт СЧ 1234', [invNum('СЧ-dddd')])).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(recognizeByMatrices('оплата сч-1234', [invNum('СЧ-dddd')]))
      .toEqual([{ kind: 'invoice-number', value: 'сч-1234' }])
  })

  it('applies several matrices and returns all, in matrix then position order', () => {
    const res = recognizeByMatrices('счёт СЧ-1 и заказ 6001', [
      invNum('СЧ-d'),
      { mask: 'dddd', kind: 'order-number' }
    ])
    expect(res).toEqual([
      { kind: 'invoice-number', value: 'СЧ-1' },
      { kind: 'order-number', value: '6001' }
    ])
  })

  it('dedups same kind+value, keeps distinct values', () => {
    expect(recognizeByMatrices('счёт 2001, ещё 2001', [invNum('dddd')]))
      .toEqual([{ kind: 'invoice-number', value: '2001' }])
    expect(recognizeByMatrices('2001 и 2002', [invNum('dddd')]))
      .toEqual([
        { kind: 'invoice-number', value: '2001' },
        { kind: 'invoice-number', value: '2002' }
      ])
  })

  it('returns [] for no match, empty mask, or empty matrix list', () => {
    expect(recognizeByMatrices('без номера', [invNum('СЧ-dddd')])).toEqual([])
    expect(recognizeByMatrices('счёт 1', [invNum('   ')])).toEqual([])
    expect(recognizeByMatrices('счёт 1', [])).toEqual([])
  })

  it('skips an absurdly long value (> MAX_ID_CHARS) without throwing', () => {
    const huge = 'd'.repeat(80)
    const text = `счёт ${'9'.repeat(80)}`
    expect(recognizeByMatrices(text, [invNum(huge)])).toEqual([])
  })

  it('accepts a value of exactly MAX_ID_CHARS (64) — no off-by-one', () => {
    const mask = 'd'.repeat(64)
    const text = `счёт ${'9'.repeat(64)} конец`
    expect(recognizeByMatrices(text, [invNum(mask)]))
      .toEqual([{ kind: 'invoice-number', value: '9'.repeat(64) }])
  })

  it('folds LOWERCASE homoglyphs too (ворс, not just ВОРС)', () => {
    expect(foldHomoglyphs('ворс', 'latin')).toBe('bopc')
    expect(recognizeByMatrices('оплата ворс-123', [invNum('BOPC-ddd')], 'latin'))
      .toEqual([{ kind: 'invoice-number', value: 'bopc-123' }])
  })

  it('folds a MIXED-alphabet token (ВOРC → BOPC under latin)', () => {
    // В,Р cyrillic + O,C latin — one visual "BOPC"
    expect(recognizeByMatrices('оплата ВOРC-9', [invNum('BOPC-d')], 'latin'))
      .toEqual([{ kind: 'invoice-number', value: 'BOPC-9' }])
  })

  it('treats uppercase D in a mask as a literal (case-insensitive match)', () => {
    expect(recognizeByMatrices('код D-1234', [invNum('D-dddd')]))
      .toEqual([{ kind: 'invoice-number', value: 'D-1234' }])
    expect(recognizeByMatrices('код d-1234', [invNum('D-dddd')]))
      .toEqual([{ kind: 'invoice-number', value: 'd-1234' }])
  })

  it('does not grab a number after a Belarusian letter (Ўў/Іі in the boundary)', () => {
    expect(recognizeByMatrices('плацёж№ў2001', [invNum('dddd')])).toEqual([])
    expect(recognizeByMatrices('код і2002', [invNum('dddd')])).toEqual([])
  })

  it('skips an over-long mask (> MAX_MASK_CHARS) without throwing', () => {
    expect(recognizeByMatrices('счёт 1', [invNum('d'.repeat(200))])).toEqual([])
  })
})
