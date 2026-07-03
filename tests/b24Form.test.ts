import { describe, expect, it } from 'vitest'
import { buildB24FormSrc, isAllowedB24FormHost } from '~/utils/b24Form'

const SCRIPT = 'https://cdn-ru.bitrix24.by/b37817748/crm/form/loader_1.js'

describe('isAllowedB24FormHost', () => {
  it('accepts https Bitrix24 cloud hosts', () => {
    expect(isAllowedB24FormHost(SCRIPT)).toBe(true)
    expect(isAllowedB24FormHost('https://x.bitrix24.com/a.js')).toBe(true)
  })

  it('rejects non-https and non-allow-listed hosts', () => {
    expect(isAllowedB24FormHost('http://cdn-ru.bitrix24.by/a.js')).toBe(false)
    expect(isAllowedB24FormHost('https://evil.example.com/a.js')).toBe(false)
    expect(isAllowedB24FormHost('not a url')).toBe(false)
  })

  it('is not fooled by a look-alike suffix host', () => {
    expect(isAllowedB24FormHost('https://bitrix24.by.evil.com/a.js')).toBe(false)
  })
})

describe('buildB24FormSrc', () => {
  it('builds the host-page URL with encoded params', () => {
    const src = buildB24FormSrc(SCRIPT, '1', '3c735r')
    expect(src).toBe(`/b24-form.html?script=${encodeURIComponent(SCRIPT)}&form=inline%2F1%2F3c735r`)
  })

  it('returns null when any part is empty (unconfigured slot)', () => {
    expect(buildB24FormSrc('', '1', '3c735r')).toBeNull()
    expect(buildB24FormSrc(SCRIPT, '', '3c735r')).toBeNull()
    expect(buildB24FormSrc(SCRIPT, '1', '')).toBeNull()
  })

  it('returns null for a disallowed script host', () => {
    expect(buildB24FormSrc('https://evil.example.com/loader.js', '1', '3c735r')).toBeNull()
  })

  it('returns null for an id/secret with unsafe characters', () => {
    expect(buildB24FormSrc(SCRIPT, '1/../x', '3c735r')).toBeNull()
    expect(buildB24FormSrc(SCRIPT, '1', 'a b')).toBeNull()
  })
})
