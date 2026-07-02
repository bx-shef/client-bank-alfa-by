import { describe, expect, it } from 'vitest'
import { b24ErrorMessage, restUrl } from '../server/utils/b24Rest'

describe('restUrl', () => {
  it('builds https://<host>/rest/<method> from a bare host', () => {
    expect(restUrl('p.bitrix24.by', 'app.option.get')).toBe('https://p.bitrix24.by/rest/app.option.get')
  })
  it('strips a scheme and any path if a full endpoint is passed', () => {
    expect(restUrl('https://p.bitrix24.by/rest/', 'app.option.set')).toBe('https://p.bitrix24.by/rest/app.option.set')
  })
  it('normalises http to https and drops a trailing path', () => {
    expect(restUrl('http://p.bitrix24.by/rest', 'app.info')).toBe('https://p.bitrix24.by/rest/app.info')
  })
  it('keeps only the host from a bare host with a path', () => {
    expect(restUrl('p.bitrix24.by/foo/bar', 'scope')).toBe('https://p.bitrix24.by/rest/scope')
  })
})

describe('b24ErrorMessage', () => {
  it('returns null for a success body (no error field)', () => {
    expect(b24ErrorMessage({ result: { id: 1 } })).toBeNull()
    expect(b24ErrorMessage({ result: true })).toBeNull()
    expect(b24ErrorMessage({ error: '' })).toBeNull() // empty error string = not an error
  })
  it('reports error with description when present', () => {
    expect(b24ErrorMessage({ error: 'NOT_FOUND', error_description: 'Not found.' })).toBe('NOT_FOUND: Not found.')
  })
  it('reports the bare error code when there is no description', () => {
    expect(b24ErrorMessage({ error: 'insufficient_scope' })).toBe('insufficient_scope')
  })
})
