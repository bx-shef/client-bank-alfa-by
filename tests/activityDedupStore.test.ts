import { describe, expect, it, vi } from 'vitest'
import { SCHEMA_SQL } from '../server/db/client'
import {
  deleteDedupForPortal,
  getActivityId,
  rememberActivity
} from '../server/utils/activityDedupStore'

describe('getActivityId', () => {
  it('returns the stored activity id for a (portal, key)', async () => {
    const query = vi.fn(async () => [{ activity_id: '4021' }])
    expect(await getActivityId(query, 'm1', 'BY13|doc-7')).toBe('4021')
    expect(query.mock.calls[0]![1]).toEqual(['m1', 'BY13|doc-7'])
  })

  it('coerces a numeric activity id to string', async () => {
    const query = vi.fn(async () => [{ activity_id: 4021 }])
    expect(await getActivityId(query, 'm1', 'k')).toBe('4021')
  })

  it('returns null when the operation was not written yet', async () => {
    expect(await getActivityId(vi.fn(async () => []), 'm1', 'k')).toBeNull()
  })

  it('scopes the lookup by member_id (SELECT filters both columns)', async () => {
    const query = vi.fn(async () => [])
    await getActivityId(query, 'm1', 'k')
    expect(query.mock.calls[0]![0]).toMatch(/WHERE member_id = \$1 AND dedup_key = \$2/)
  })
})

describe('rememberActivity', () => {
  it('inserts write-once (ON CONFLICT DO NOTHING) and reports insertion', async () => {
    const query = vi.fn(async () => [{ activity_id: '4021' }]) // RETURNING → a row
    const inserted = await rememberActivity(query, 'm1', 'BY13|doc-7', '4021')
    expect(inserted).toBe(true)
    expect(query.mock.calls[0]![0]).toMatch(/ON CONFLICT \(member_id, dedup_key\) DO NOTHING/)
    expect(query.mock.calls[0]![1]).toEqual(['m1', 'BY13|doc-7', '4021'])
  })

  it('reports false when the mapping already existed (no RETURNING row)', async () => {
    const query = vi.fn(async () => []) // conflict → nothing returned
    expect(await rememberActivity(query, 'm1', 'k', '9')).toBe(false)
  })
})

describe('deleteDedupForPortal', () => {
  it('issues a DELETE by member_id (uninstall purges the whole portal)', async () => {
    const query = vi.fn(async () => [])
    await deleteDedupForPortal(query, 'm1')
    expect(query.mock.calls[0]![0]).toMatch(/DELETE FROM activity_dedup WHERE member_id = \$1/)
    expect(query.mock.calls[0]![1]).toEqual(['m1'])
  })
})

// Offline guard: SCHEMA_SQL must define every column/constraint the store uses —
// a live DB would error on a mismatch; the fake-query tests can't catch it.
describe('SCHEMA_SQL ↔ activity_dedup queries', () => {
  it('defines the activity_dedup table with every column the store touches', () => {
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS activity_dedup/)
    for (const col of ['member_id', 'dedup_key', 'activity_id']) {
      expect(SCHEMA_SQL).toContain(col)
    }
  })
  it('keys the table by (member_id, dedup_key) — the ON CONFLICT target', () => {
    expect(SCHEMA_SQL).toMatch(/PRIMARY KEY \(member_id, dedup_key\)/)
  })
})
