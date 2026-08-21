import { describe, expect, it } from 'vitest'
import { extractPayments, paymentListParams, pickFreeEntityTypeId, validateTestWebhook } from '../scripts/lib/b24-seed-utils.mjs'

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

// ⚠ THE ONLY thing that checks this helper's body. Nothing else can: `.mjs` bodies are read by
// neither typecheck (`checkJs` is off) nor ESLint (not type-aware here), and the choke-point guard
// in `paymentListParamsChokePoint.test.ts` looks at the SHAPE OF THE CALL, not at what the callee
// does — proven by mutation: dropping the `Number(...)` inside this function left that guard green.
// The coercion is the whole point (`crm.item.payment.list` wants a numeric `entityId`; a string
// goes out silently), so it needs a test that fails when it disappears.
describe('paymentListParams', () => {
  it('coerces a numeric string to a number', () => {
    expect(paymentListParams('7')).toEqual({ entityId: 7, entityTypeId: 2 })
  })
  it('leaves an actual number alone', () => {
    expect(paymentListParams(123)).toEqual({ entityId: 123, entityTypeId: 2 })
  })
  it('always names the deal entity type', () => {
    expect(paymentListParams(1).entityTypeId).toBe(2)
  })
  it('does not silently pass a string through', () => {
    // The regression this exists for: `entityId: "123"` instead of `123` (#542).
    expect(typeof paymentListParams('123').entityId).toBe('number')
  })
})
