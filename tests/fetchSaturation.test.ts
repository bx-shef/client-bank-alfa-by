import { describe, expect, it } from 'vitest'
import {
  clampSaturationThreshold,
  DEFAULT_FETCH_SATURATION_THRESHOLD,
  fetchBacklogSaturation
} from '../server/queue/saturation'

describe('clampSaturationThreshold', () => {
  it('keeps a positive integer', () => {
    expect(clampSaturationThreshold(50)).toBe(50)
  })

  it('floors a fractional value', () => {
    expect(clampSaturationThreshold(50.9)).toBe(50)
  })

  it.each([0, -10, NaN, Infinity])('falls back to default for %s (can never silence the signal)', (v) => {
    expect(clampSaturationThreshold(v)).toBe(DEFAULT_FETCH_SATURATION_THRESHOLD)
  })
})

describe('fetchBacklogSaturation', () => {
  it('sums waiting + delayed into the backlog', () => {
    expect(fetchBacklogSaturation({ waiting: 30, delayed: 20 }, 100).backlog).toBe(50)
  })

  it('is under threshold when backlog < threshold', () => {
    expect(fetchBacklogSaturation({ waiting: 40, delayed: 40 }, 100)).toEqual({ backlog: 80, over: false })
  })

  it('trips exactly at the threshold (≥)', () => {
    expect(fetchBacklogSaturation({ waiting: 60, delayed: 40 }, 100)).toEqual({ backlog: 100, over: true })
  })

  it('trips above the threshold', () => {
    expect(fetchBacklogSaturation({ waiting: 300, delayed: 0 }, 100).over).toBe(true)
  })

  it('coerces missing/garbage counts to 0 (partial snapshot never yields NaN)', () => {
    expect(fetchBacklogSaturation({}, 100)).toEqual({ backlog: 0, over: false })
    expect(fetchBacklogSaturation({ waiting: -5, delayed: NaN }, 100)).toEqual({ backlog: 0, over: false })
  })

  it('floors fractional counts (symmetry with the threshold floor)', () => {
    expect(fetchBacklogSaturation({ waiting: 10.9, delayed: 0.9 }, 100).backlog).toBe(10)
  })

  it('a huge backlog still trips without crashing (never NaN)', () => {
    const v = fetchBacklogSaturation({ waiting: Number.MAX_VALUE, delayed: Number.MAX_VALUE }, 100)
    expect(v.over).toBe(true)
    expect(Number.isNaN(v.backlog)).toBe(false)
  })

  it('applies the clamped default when the threshold is invalid', () => {
    // A garbage threshold must not disable the signal: it falls back to the default.
    const v = fetchBacklogSaturation({ waiting: DEFAULT_FETCH_SATURATION_THRESHOLD, delayed: 0 }, 0)
    expect(v.over).toBe(true)
  })
})
