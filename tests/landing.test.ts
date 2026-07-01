import { describe, expect, it } from 'vitest'
import { LANDING_FEATURES, LANDING_TITLE, copyrightYears, ogImageUrl, pageTitle } from '~/utils/landing'

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
