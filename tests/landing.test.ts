import { describe, expect, it } from 'vitest'
import { LANDING_FEATURES, LANDING_STEPS, LANDING_PAIN_RESULT, LANDING_INTEGRATORS, LANDING_FORMATS, LANDING_TITLE, copyrightYears, ogImageUrl, pageTitle } from '~/utils/landing'

describe('copyrightYears', () => {
  it('shows a single year when start === current', () => {
    expect(copyrightYears(2026, 2026)).toBe('2026')
  })

  it('shows a range when the project spans multiple years', () => {
    expect(copyrightYears(2026, 2030)).toBe('2026–2030')
  })

  it('does not produce a backwards range', () => {
    // Clock skew / wrong system date should not render "2026–2025".
    expect(copyrightYears(2026, 2025)).toBe('2026')
  })
})

describe('pageTitle', () => {
  it('appends the app name as a suffix', () => {
    expect(pageTitle('Настройки')).toBe(`Настройки — ${LANDING_TITLE}`)
  })
})

describe('ogImageUrl', () => {
  it('is a relative /og.png when siteUrl is empty (dev)', () => {
    expect(ogImageUrl('')).toBe('/og.png')
  })
  it('builds an absolute URL when siteUrl is set (prod)', () => {
    expect(ogImageUrl('https://bank-import.bx-shef.by')).toBe('https://bank-import.bx-shef.by/og.png')
  })
  it('does not double the slash when siteUrl has a trailing slash', () => {
    expect(ogImageUrl('https://example.com/')).toBe('https://example.com/og.png')
  })
})

describe('LANDING_FEATURES', () => {
  it('every feature has a non-empty title and description', () => {
    expect(LANDING_FEATURES.length).toBeGreaterThan(0)
    for (const feature of LANDING_FEATURES) {
      expect(feature.title.trim()).not.toBe('')
      expect(feature.description.trim()).not.toBe('')
    }
  })
})

describe('LANDING_STEPS', () => {
  it('numbers the steps 01..03 with filled title/text', () => {
    expect(LANDING_STEPS.map(s => s.step)).toEqual(['01', '02', '03'])
    for (const s of LANDING_STEPS) {
      expect(s.title.trim()).not.toBe('')
      expect(s.text.trim()).not.toBe('')
    }
  })
})

describe('pain → result copy', () => {
  it('has both a before and after line', () => {
    expect(LANDING_PAIN_RESULT.before.trim()).not.toBe('')
    expect(LANDING_PAIN_RESULT.after.trim()).not.toBe('')
  })

  it('has non-empty integrators copy', () => {
    expect(LANDING_INTEGRATORS.trim()).not.toBe('')
    expect(LANDING_INTEGRATORS).toContain('коннектор')
  })

  it('lists the supported banks/formats', () => {
    expect(LANDING_FORMATS.length).toBeGreaterThan(0)
    expect(LANDING_FORMATS).toContain('Альфа-Банк Беларусь')
    expect(LANDING_FORMATS).toContain('Приорбанк')
    for (const f of LANDING_FORMATS) expect(f.trim()).not.toBe('')
  })
})
