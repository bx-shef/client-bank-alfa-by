import { describe, expect, it } from 'vitest'
import { LANDING_FEATURES, copyrightYears } from '../app/utils/landing'

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

describe('LANDING_FEATURES', () => {
  it('every feature has a non-empty title and description', () => {
    expect(LANDING_FEATURES.length).toBeGreaterThan(0)
    for (const feature of LANDING_FEATURES) {
      expect(feature.title.trim()).not.toBe('')
      expect(feature.description.trim()).not.toBe('')
    }
  })
})
