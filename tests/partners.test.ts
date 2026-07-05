import { describe, expect, it } from 'vitest'
import {
  PARTNERS_TITLE,
  PARTNERS_DESCRIPTION,
  PARTNERS_MODEL,
  PARTNERS_LADDER,
  PARTNERS_SPLIT,
  PARTNERS_LIMITS,
  PARTNERS_BRIEF
} from '~/utils/partners'

describe('partners copy', () => {
  it('has a non-empty title and description', () => {
    expect(PARTNERS_TITLE.trim()).not.toBe('')
    expect(PARTNERS_DESCRIPTION.trim()).not.toBe('')
  })

  it('states the subcontracting model', () => {
    expect(PARTNERS_MODEL.length).toBeGreaterThan(0)
    expect(PARTNERS_MODEL.some(m => /субподряд/i.test(m))).toBe(true)
    for (const m of PARTNERS_MODEL) expect(m.trim()).not.toBe('')
  })

  it('has a sales ladder with a free entry rung and paid rungs done by us', () => {
    expect(PARTNERS_LADDER.length).toBeGreaterThanOrEqual(3)
    // Exactly one free entry point; the rest are paid work on our side.
    expect(PARTNERS_LADDER.filter(r => r.paid === 'free').length).toBe(1)
    expect(PARTNERS_LADDER.some(r => r.paid === 'us')).toBe(true)
    for (const r of PARTNERS_LADDER) {
      expect(r.level.trim()).not.toBe('')
      expect(r.client.trim()).not.toBe('')
      expect(r.who.trim()).not.toBe('')
    }
  })

  it('splits work between partner and us, both non-empty', () => {
    expect(PARTNERS_SPLIT.partner.length).toBeGreaterThan(0)
    expect(PARTNERS_SPLIT.us.length).toBeGreaterThan(0)
    for (const item of [...PARTNERS_SPLIT.partner, ...PARTNERS_SPLIT.us]) {
      expect(item.trim()).not.toBe('')
    }
  })

  it('has a promise-boundary note and a client mini-brief', () => {
    expect(PARTNERS_LIMITS.trim()).not.toBe('')
    expect(PARTNERS_BRIEF.length).toBeGreaterThan(0)
    for (const item of PARTNERS_BRIEF) expect(item.trim()).not.toBe('')
  })
})
