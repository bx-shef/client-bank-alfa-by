import { describe, expect, it } from 'vitest'
import { DEFAULT_REDIRECT, safeRedirect } from '../app/utils/loginRedirect'

// Post-login redirect guard (see docs/AUTH.md): allow only same-site relative
// paths; every open-redirect shape must fall back to DEFAULT_REDIRECT.

describe('safeRedirect', () => {
  it('accepts a plain same-site relative path', () => {
    expect(safeRedirect('/queues')).toBe('/queues')
    expect(safeRedirect('/app?tab=1')).toBe('/app?tab=1')
    expect(safeRedirect('/a/b/c')).toBe('/a/b/c')
  })

  it('rejects protocol-relative and backslash-bypass open redirects', () => {
    expect(safeRedirect('//evil.com')).toBe(DEFAULT_REDIRECT)
    expect(safeRedirect('/\\evil.com')).toBe(DEFAULT_REDIRECT) // `/\evil.com`
    expect(safeRedirect('/\\\\evil.com')).toBe(DEFAULT_REDIRECT)
    expect(safeRedirect('https://evil.com')).toBe(DEFAULT_REDIRECT)
    expect(safeRedirect('http:/evil.com')).toBe(DEFAULT_REDIRECT)
  })

  it('rejects non-relative / non-string inputs', () => {
    expect(safeRedirect('evil.com')).toBe(DEFAULT_REDIRECT)
    expect(safeRedirect('')).toBe(DEFAULT_REDIRECT)
    expect(safeRedirect(undefined)).toBe(DEFAULT_REDIRECT)
    expect(safeRedirect(['/queues'])).toBe(DEFAULT_REDIRECT)
  })
})
