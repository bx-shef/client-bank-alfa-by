import { describe, expect, it, vi } from 'vitest'
import { SCHEMA_SQL } from '../server/db/client'
import {
  deleteFactsForPortal,
  getAllocationFact,
  recordAllocation,
  revertAllocation
} from '../server/utils/allocationFactStore'

// Persistent allocation fact store (#109). Fake-query tests: assert SQL shape and
// params without a DB (same pattern as activityDedupStore).

describe('getAllocationFact', () => {
  it('returns the stored fact for a (portal, factKey)', async () => {
    const query = vi.fn(async () => [{ status: 'allocated', target_kind: 'invoice', target_id: '7' }])
    expect(await getAllocationFact(query, 'm1', 'ACC|DOC|invoice|7'))
      .toEqual({ status: 'allocated', targetKind: 'invoice', targetId: '7' })
    expect(query.mock.calls[0]![1]).toEqual(['m1', 'ACC|DOC|invoice|7'])
    expect(query.mock.calls[0]![0]).toMatch(/WHERE member_id = \$1 AND fact_key = \$2/)
  })
  it('normalizes an unknown status to allocated and coerces ids to string', async () => {
    const query = vi.fn(async () => [{ status: 'weird', target_kind: 'deal', target_id: 42 }])
    expect(await getAllocationFact(query, 'm1', 'k')).toEqual({ status: 'allocated', targetKind: 'deal', targetId: '42' })
  })
  it('reads a reverted fact as reverted', async () => {
    const query = vi.fn(async () => [{ status: 'reverted', target_kind: 'invoice', target_id: '7' }])
    expect((await getAllocationFact(query, 'm1', 'k'))?.status).toBe('reverted')
  })
  it('returns null when no fact exists', async () => {
    expect(await getAllocationFact(vi.fn(async () => []), 'm1', 'k')).toBeNull()
  })
})

describe('recordAllocation', () => {
  it('inserts write-once (ON CONFLICT DO NOTHING) and reports insertion', async () => {
    const query = vi.fn(async () => [{ fact_key: 'k' }])
    expect(await recordAllocation(query, 'm1', 'k', 'invoice', '7')).toBe(true)
    expect(query.mock.calls[0]![0]).toMatch(/ON CONFLICT \(member_id, fact_key\) DO NOTHING/)
    expect(query.mock.calls[0]![1]).toEqual(['m1', 'k', 'invoice', '7'])
  })
  it('reports false when the fact already existed (no RETURNING row)', async () => {
    expect(await recordAllocation(vi.fn(async () => []), 'm1', 'k', 'invoice', '7')).toBe(false)
  })
})

describe('revertAllocation', () => {
  it('flips only an allocated row to reverted and bumps updated_at', async () => {
    const query = vi.fn(async () => [{ fact_key: 'k' }])
    expect(await revertAllocation(query, 'm1', 'k')).toBe(true)
    expect(query.mock.calls[0]![0]).toMatch(/SET status = 'reverted', updated_at = now\(\)/)
    expect(query.mock.calls[0]![0]).toMatch(/AND status = 'allocated'/)
    expect(query.mock.calls[0]![1]).toEqual(['m1', 'k'])
  })
  it('reports false when there was no allocated fact to revert (idempotent)', async () => {
    expect(await revertAllocation(vi.fn(async () => []), 'm1', 'k')).toBe(false)
  })
})

describe('deleteFactsForPortal', () => {
  it('issues a DELETE by member_id (uninstall purges the whole portal)', async () => {
    const query = vi.fn(async () => [])
    await deleteFactsForPortal(query, 'm1')
    expect(query.mock.calls[0]![0]).toMatch(/DELETE FROM allocation_fact WHERE member_id = \$1/)
    expect(query.mock.calls[0]![1]).toEqual(['m1'])
  })
})

describe('SCHEMA_SQL ↔ allocation_fact queries', () => {
  it('defines allocation_fact with every column the store touches', () => {
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS allocation_fact/)
    for (const col of ['member_id', 'fact_key', 'target_kind', 'target_id', 'status', 'updated_at']) {
      expect(SCHEMA_SQL).toContain(col)
    }
  })
  it('keys the table by (member_id, fact_key) — the ON CONFLICT target', () => {
    expect(SCHEMA_SQL).toMatch(/PRIMARY KEY \(member_id, fact_key\)/)
  })
})
