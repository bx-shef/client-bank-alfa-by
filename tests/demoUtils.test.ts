import { describe, it, expect } from 'vitest'
// The demo script is plain ESM (standalone, no build); import its helpers directly.
import {
  parseArgs,
  parseDotEnvLine,
  maskToken,
  maskNumber,
  trunc,
  extractRedirect,
  redactTokenSet,
  isHttpUrl
} from '../scripts/lib/demo-utils.mjs'

describe('parseArgs', () => {
  it('parses value flags and boolean flags', () => {
    expect(parseArgs(['--env', '.env.sandbox', '--full', '--from-year', '2024']))
      .toEqual({ 'env': '.env.sandbox', 'full': true, 'from-year': '2024' })
  })
  it('treats a flag followed by another flag as boolean', () => {
    expect(parseArgs(['--url-only', '--account', '123'])).toEqual({ 'url-only': true, 'account': '123' })
  })
  it('ignores non-flag tokens', () => {
    expect(parseArgs(['junk', '--x', 'y'])).toEqual({ x: 'y' })
  })
})

describe('parseDotEnvLine', () => {
  it('parses KEY=VALUE', () => {
    expect(parseDotEnvLine('ALFA_CLIENT_ID=abc')).toEqual(['ALFA_CLIENT_ID', 'abc'])
  })
  it('skips comments and blanks', () => {
    expect(parseDotEnvLine('# comment')).toBeNull()
    expect(parseDotEnvLine('   ')).toBeNull()
    expect(parseDotEnvLine('#### header ####')).toBeNull()
  })
  it('trims whitespace around = and value', () => {
    expect(parseDotEnvLine('  KEY =  val  ')).toEqual(['KEY', 'val'])
  })
  it('unwraps quotes verbatim', () => {
    expect(parseDotEnvLine('K="a b"')).toEqual(['K', 'a b'])
    expect(parseDotEnvLine('K=\'a b\'')).toEqual(['K', 'a b'])
  })
  it('strips an inline comment from unquoted values', () => {
    expect(parseDotEnvLine('ALFA_SCOPE=accounts # only this scope')).toEqual(['ALFA_SCOPE', 'accounts'])
  })
  it('keeps a # that is part of an unquoted value (no leading space)', () => {
    expect(parseDotEnvLine('URL=https://h/p#frag')).toEqual(['URL', 'https://h/p#frag'])
  })
  it('keeps a # inside a quoted value', () => {
    expect(parseDotEnvLine('K="a # b"')).toEqual(['K', 'a # b'])
  })
  it('yields an empty string for KEY=', () => {
    expect(parseDotEnvLine('ALFA_CLIENT_SECRET=')).toEqual(['ALFA_CLIENT_SECRET', ''])
  })
})

describe('maskToken', () => {
  it('shows first 8 chars + length', () => {
    expect(maskToken('ibHZMkuo0123456789', false)).toBe('ibHZMkuo…[18 chars]')
  })
  it('passes empty/nullish through (nothing to leak)', () => {
    expect(maskToken('', false)).toBe('')
    expect(maskToken(undefined, false)).toBeUndefined()
  })
  it('returns the raw token when full=true', () => {
    expect(maskToken('secret-token', true)).toBe('secret-token')
  })
})

describe('maskNumber', () => {
  it('keeps the last 4 of a long number', () => {
    expect(maskNumber('BY12ALFA30120000', false)).toBe('****0000')
  })
  it('masks fully when length <= 4', () => {
    expect(maskNumber('1234', false)).toBe('****')
  })
  it('masks the literal string "0" (not treated as empty)', () => {
    expect(maskNumber('0', false)).toBe('****')
  })
  it('passes null/empty through and respects full', () => {
    expect(maskNumber(null, false)).toBeNull()
    expect(maskNumber('', false)).toBe('')
    expect(maskNumber('BY12...0000', true)).toBe('BY12...0000')
  })
})

describe('trunc', () => {
  it('truncates long strings', () => {
    expect(trunc('abcdef', 3)).toBe('abc…')
  })
  it('leaves short strings and nullish alone', () => {
    expect(trunc('ab', 3)).toBe('ab')
    expect(trunc(undefined)).toBeUndefined()
  })
})

describe('extractRedirect', () => {
  it('pulls code+state from a full redirect URL', () => {
    expect(extractRedirect('https://app/cb?code=AUTH123&state=s1')).toEqual({ code: 'AUTH123', state: 's1' })
  })
  it('parses a bare query string', () => {
    expect(extractRedirect('?code=XYZ&state=s2')).toEqual({ code: 'XYZ', state: 's2' })
  })
  it('treats a raw code (no code= param) as the code', () => {
    expect(extractRedirect('  1c00f727-dead-beef  ')).toEqual({ code: '1c00f727-dead-beef', state: null })
  })
  it('returns nulls for empty input', () => {
    expect(extractRedirect('')).toEqual({ code: null, state: null })
  })
})

describe('redactTokenSet', () => {
  it('redacts access/refresh tokens, keeps other fields', () => {
    expect(redactTokenSet({ access_token: 'a', refresh_token: 'b', scope: 'accounts', expires_in: 3600 }))
      .toEqual({ access_token: '[REDACTED]', refresh_token: '[REDACTED]', scope: 'accounts', expires_in: 3600 })
  })
  it('passes null through', () => {
    expect(redactTokenSet(null)).toBeNull()
  })
})

describe('isHttpUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(isHttpUrl('https://developerhub.alfabank.by:8273/authorize?x=1&y=2')).toBe(true)
  })
  it('rejects non-URLs and other schemes', () => {
    expect(isHttpUrl('https://evil" & calc')).toBe(false)
    expect(isHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })
})
