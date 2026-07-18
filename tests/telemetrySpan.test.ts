import { describe, expect, it } from 'vitest'
import { errorKind, withDependencySpan, withSpan } from '../server/utils/telemetrySpan'

// With no OTel SDK registered (the default in tests), the API returns no-op spans, so these
// verify the CONTROL FLOW (result pass-through, rethrow) and the pure errorKind sanitizer.

describe('errorKind', () => {
  it('uses a code/name token, never the message', () => {
    expect(errorKind({ code: 'QUERY_LIMIT_EXCEEDED' })).toBe('QUERY_LIMIT_EXCEEDED')
    expect(errorKind(new TypeError('boom'))).toBe('TypeError')
  })
  it('strips non-token chars (a message-y code cannot leak free text/PII)', () => {
    expect(errorKind({ code: 'оплата 1840 BYN на счёт BY80' })).toBe('1840BYNBY80') // cyrillic/spaces stripped
    expect(errorKind({ name: 'weird name!!! @#$' })).toBe('weirdname')
  })
  it('caps length and falls back to "error"', () => {
    expect(errorKind({ code: 'x'.repeat(200) }).length).toBe(64)
    expect(errorKind({})).toBe('error')
    expect(errorKind(null)).toBe('error')
  })
})

describe('withDependencySpan', () => {
  it('returns the fn result (happy path)', async () => {
    const r = await withDependencySpan({ system: 'bitrix24', operation: 'crm.item.list' }, async () => 42)
    expect(r).toBe(42)
  })
  it('rethrows the original error (never swallows)', async () => {
    const err = new Error('nope')
    await expect(withDependencySpan({ system: 'alfa', operation: 'oauth.refresh' }, async () => {
      throw err
    })).rejects.toBe(err)
  })
})

describe('withSpan', () => {
  it('returns the fn result and accepts a finalize hook', async () => {
    const r = await withSpan('crm-sync job', { 'job.queue': 'crm-sync' }, async () => ({ created: 3 }), res => ({ 'job.op_count': res.created }))
    expect(r).toEqual({ created: 3 })
  })
  it('rethrows on error', async () => {
    await expect(withSpan('crm-sync job', {}, async () => {
      throw new Error('x')
    })).rejects.toThrow('x')
  })
})
