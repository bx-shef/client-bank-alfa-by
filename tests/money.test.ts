import { describe, expect, it } from 'vitest'
import { round2 } from '~/utils/money'

describe('round2', () => {
  it('rounds to 2 decimals without float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(1.005)).toBe(1.01)
    expect(round2(2.675)).toBe(2.68)
    expect(round2(100)).toBe(100)
  })
  it('coerces a non-finite input to 0 (a bad row cannot poison a total)', () => {
    expect(round2(Number.NaN)).toBe(0)
    expect(round2(Number.POSITIVE_INFINITY)).toBe(0)
  })
})
