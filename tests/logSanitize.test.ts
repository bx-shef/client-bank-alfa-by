import { describe, expect, it } from 'vitest'
import { describeUpstreamError, sanitizeForLog } from '../server/utils/logSanitize'

describe('sanitizeForLog', () => {
  it('strips CR/LF so provider text cannot forge extra log lines', () => {
    expect(sanitizeForLog('bad\r\n[bank-connect] ok')).toBe('bad [bank-connect] ok')
  })

  it('caps the length', () => {
    expect(sanitizeForLog('x'.repeat(500))).toHaveLength(200)
  })
})

describe('describeUpstreamError', () => {
  it('keeps the message when there is no response body', () => {
    expect(describeUpstreamError(new Error('[POST] "https://bank/x": 400 Bad Request')))
      .toBe('[POST] "https://bank/x": 400 Bad Request')
  })

  it('appends the bank error envelope — the half that names the offending field', () => {
    const err = Object.assign(new Error('[POST] "https://bank/accountConsents": 400 Bad Request'), {
      data: { Code: '400 BadRequest', Errors: [{ ErrorCode: 'BY.NBRB.Field.Invalid' }] }
    })
    expect(describeUpstreamError(err)).toContain('BY.NBRB.Field.Invalid')
    expect(describeUpstreamError(err)).toContain('400 Bad Request')
  })

  it('renders a string body as-is', () => {
    const err = Object.assign(new Error('boom'), { data: 'plain upstream text' })
    expect(describeUpstreamError(err)).toBe('boom :: plain upstream text')
  })

  it('sanitizes the body too — a multiline envelope cannot inject log lines', () => {
    const err = Object.assign(new Error('boom'), { data: 'line1\nline2' })
    expect(describeUpstreamError(err)).toBe('boom :: line1 line2')
  })

  it('caps the combined text', () => {
    const err = Object.assign(new Error('boom'), { data: 'y'.repeat(1000) })
    expect(describeUpstreamError(err)).toHaveLength(400)
  })

  it('survives a circular body instead of throwing over the original failure', () => {
    const data: Record<string, unknown> = {}
    data.self = data
    const err = Object.assign(new Error('boom'), { data })
    expect(describeUpstreamError(err)).toBe('boom :: [unserializable]')
  })

  it('falls back to a generic label for a non-Error throw', () => {
    expect(describeUpstreamError('just a string')).toBe('error')
    expect(describeUpstreamError(null)).toBe('error')
  })
})
