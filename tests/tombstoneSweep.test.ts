import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOMBSTONE_TTL_DAYS, resolveTombstoneDays, sweepExpiredTombstones } from '../server/utils/tombstoneSweep'

describe('resolveTombstoneDays', () => {
  it('defaults to 30 for absent / non-numeric', () => {
    expect(resolveTombstoneDays(undefined)).toBe(DEFAULT_TOMBSTONE_TTL_DAYS)
    expect(resolveTombstoneDays('')).toBe(30)
    expect(resolveTombstoneDays('abc')).toBe(30)
  })
  it('passes through an in-range integer and floors fractions', () => {
    expect(resolveTombstoneDays('7')).toBe(7)
    expect(resolveTombstoneDays('45.9')).toBe(45)
  })
  it('clamps to [1, 365]', () => {
    expect(resolveTombstoneDays('0')).toBe(1)
    expect(resolveTombstoneDays('-5')).toBe(1)
    expect(resolveTombstoneDays('99999')).toBe(365)
  })
})

describe('sweepExpiredTombstones', () => {
  it('deletes rows older than `days` (deleted_ts in seconds) and returns the count', async () => {
    const query = vi.fn(async () => [{ member_id: 'a' }, { member_id: 'b' }])
    const removed = await sweepExpiredTombstones(query, 30)
    expect(removed).toBe(2)
    const [sql, params] = query.mock.calls[0]!
    // Predicate compares against EXTRACT(EPOCH FROM now()) (seconds) minus the TTL window.
    expect(sql).toMatch(/DELETE FROM portal_tombstone/i)
    expect(sql).toMatch(/EXTRACT\(EPOCH FROM now\(\)\)/i)
    expect(sql).toMatch(/RETURNING member_id/i)
    expect(params).toEqual([30 * 86_400]) // seconds
  })
  it('returns 0 on an empty table', async () => {
    const query = vi.fn(async () => [])
    expect(await sweepExpiredTombstones(query, 30)).toBe(0)
  })
})
