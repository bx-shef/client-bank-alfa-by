import { describe, expect, it } from 'vitest'
import { DEFAULT_B24_FORM, buildB24FormSrc, isAllowedB24FormHost, resolveB24Form } from '~/utils/b24Form'

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

describe('resolveB24Form', () => {
  const EMPTY = { scriptUrl: '', formId: '', formSecret: '' }

  it('ничего не задано вне локального режима — наша форма', () => {
    // Так выглядит прод: переменные репозитория не заданы, Dockerfile отдаёт пустые строки.
    // С #701 здесь была заглушка вместо формы заявок (замерено 2026-09-27).
    expect(resolveB24Form(EMPTY, false)).toEqual(DEFAULT_B24_FORM)
    expect(resolveB24Form({ scriptUrl: undefined, formId: null, formSecret: ' ' }, false)).toEqual(DEFAULT_B24_FORM)
    const f = resolveB24Form(EMPTY, false)
    expect(buildB24FormSrc(f.scriptUrl, f.formId, f.formSecret)).toMatch(/^\/b24-form\.html\?/)
  })

  it('ничего не задано в локальном режиме — заглушка: заявки клона не уходят в нашу CRM', () => {
    const f = resolveB24Form(EMPTY, true)
    expect(f).toEqual(EMPTY)
    expect(buildB24FormSrc(f.scriptUrl, f.formId, f.formSecret)).toBeNull()
  })

  it('заданная форма берётся как есть, и в локальном режиме тоже', () => {
    const own = { scriptUrl: 'https://cdn.bitrix24.by/b1/crm/form/loader_7.js', formId: '7', formSecret: 'abc' }
    expect(resolveB24Form(own, true)).toEqual(own)
    expect(resolveB24Form(own, false)).toEqual(own)
  })

  it('неполная настройка не подменяется нашей — её отвергнет buildB24FormSrc', () => {
    const f = resolveB24Form({ scriptUrl: '', formId: '7', formSecret: '' }, false)
    expect(f).toEqual({ scriptUrl: '', formId: '7', formSecret: '' })
    expect(buildB24FormSrc(f.scriptUrl, f.formId, f.formSecret)).toBeNull()
  })

  it('число из destr — строка', () => {
    expect(resolveB24Form({ scriptUrl: 'https://x.bitrix24.by/l.js', formId: 7, formSecret: 'abc' }, false).formId).toBe('7')
  })
})
