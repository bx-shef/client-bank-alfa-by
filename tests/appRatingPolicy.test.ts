import { describe, expect, it } from 'vitest'
import { RATING_REPROMPT_DAYS, shouldPrompt } from '../server/utils/appRatingPolicy'

const NOW = new Date('2026-07-19T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000)

describe('shouldPrompt', () => {
  it('shows when there is no row yet (first-ever)', () => {
    expect(shouldPrompt(null, NOW)).toBe(true)
  })

  it('shows when a row exists but was never actually prompted', () => {
    expect(shouldPrompt({ promptedAt: null, openedAt: null, reviewed: false }, NOW)).toBe(true)
  })

  it('never shows once a review is confirmed', () => {
    expect(shouldPrompt({ promptedAt: daysAgo(999), openedAt: null, reviewed: true }, NOW)).toBe(false)
  })

  it('suppresses while opened_at is set (awaiting manual verification)', () => {
    expect(shouldPrompt({ promptedAt: daysAgo(999), openedAt: daysAgo(1), reviewed: false }, NOW)).toBe(false)
  })

  it('throttles: hidden within the re-prompt interval', () => {
    expect(shouldPrompt({ promptedAt: daysAgo(RATING_REPROMPT_DAYS - 1), openedAt: null, reviewed: false }, NOW)).toBe(false)
  })

  it('shows again once the re-prompt interval has elapsed', () => {
    expect(shouldPrompt({ promptedAt: daysAgo(RATING_REPROMPT_DAYS), openedAt: null, reviewed: false }, NOW)).toBe(true)
  })

  it('honours a custom re-prompt interval', () => {
    const st = { promptedAt: daysAgo(2), openedAt: null, reviewed: false }
    expect(shouldPrompt(st, NOW, { repromptDays: 1 })).toBe(true)
    expect(shouldPrompt(st, NOW, { repromptDays: 3 })).toBe(false)
  })
})
