import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs dev-script helper, no d.ts
import { extractPayments, pickFreeEntityTypeId, validateTestWebhook } from '../scripts/lib/b24-seed-utils.mjs'

// Pure helpers for scripts/seed-test-b24.mjs — the two bits with real logic.

describe('validateTestWebhook', () => {
  it('accepts a well-formed webhook and adds the trailing slash', () => {
    expect(validateTestWebhook('https://p.bitrix24.ru/rest/1/tok3n'))
      .toBe('https://p.bitrix24.ru/rest/1/tok3n/')
  })
  it('keeps an already-slashed URL and trims surrounding space', () => {
    expect(validateTestWebhook('  https://p.bitrix24.ru/rest/12/abc/  '))
      .toBe('https://p.bitrix24.ru/rest/12/abc/')
  })
  it('rejects a non-https URL', () => {
    expect(validateTestWebhook('http://p.bitrix24.ru/rest/1/tok/')).toBeNull()
  })
  it('rejects a URL missing the /rest/<userId>/<token>/ shape', () => {
    expect(validateTestWebhook('https://p.bitrix24.ru/')).toBeNull()
    expect(validateTestWebhook('https://p.bitrix24.ru/rest/abc/tok/')).toBeNull()
  })
  it('rejects empty / undefined input', () => {
    expect(validateTestWebhook('')).toBeNull()
    expect(validateTestWebhook(undefined)).toBeNull()
  })
})

describe('extractPayments', () => {
  it('returns a bare array result as-is (the real crm.item.payment.list shape)', () => {
    expect(extractPayments([{ id: 1, paid: 'Y' }])).toEqual([{ id: 1, paid: 'Y' }])
  })
  it('unwraps a { payments: [...] } shape', () => {
    expect(extractPayments({ payments: [{ id: 2 }] })).toEqual([{ id: 2 }])
  })
  it('returns [] for null / non-array / missing key', () => {
    expect(extractPayments(null)).toEqual([])
    expect(extractPayments(undefined)).toEqual([])
    expect(extractPayments({})).toEqual([])
    expect(extractPayments({ payments: 'x' })).toEqual([])
  })
})

describe('pickFreeEntityTypeId', () => {
  it('returns the start id when nothing is used', () => {
    expect(pickFreeEntityTypeId([])).toBe(1030)
  })
  it('steps by 2 over taken ids (stays even)', () => {
    expect(pickFreeEntityTypeId([1030])).toBe(1032)
    expect(pickFreeEntityTypeId([1030, 1032])).toBe(1034)
  })
  it('skips a gap and coerces string ids', () => {
    expect(pickFreeEntityTypeId(['1030', '1034'])).toBe(1032)
  })
  it('is unaffected by unrelated odd ids', () => {
    expect(pickFreeEntityTypeId([1031, 1033])).toBe(1030)
  })
})
