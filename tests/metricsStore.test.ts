import { describe, expect, it, vi } from 'vitest'
import type { QueryFn } from '../server/utils/tokenStore'
import {
  METRICS,
  FEEDBACK_METRICS,
  bumpCounter,
  bumpCounters,
  readCounters,
  resetCounters,
  deleteMetricsForPortal,
  metricsFromSummary
} from '../server/utils/metricsStore'

/** A tiny in-memory stand-in for the metrics_counter table, driven by the SQL shape
 *  the store emits (INSERT…ON CONFLICT upsert / SELECT / DELETE). Keyed member|name. */
function fakeStore() {
  const rows = new Map<string, number>()
  const key = (m: string, n: string) => `${m}|${n}`
  const query: QueryFn = async (sql, params = []) => {
    const p = params as unknown[]
    if (sql.includes('INSERT INTO metrics_counter')) {
      const [m, n, v] = [String(p[0]), String(p[1]), Number(p[2])]
      rows.set(key(m, n), (rows.get(key(m, n)) ?? 0) + v)
      return []
    }
    if (sql.startsWith('SELECT')) {
      const m = String(p[0])
      return [...rows.entries()]
        .filter(([k]) => k.startsWith(`${m}|`))
        .map(([k, value]) => ({ name: k.split('|')[1], value }))
    }
    if (sql.startsWith('DELETE')) {
      const m = String(p[0])
      for (const k of [...rows.keys()]) if (k.startsWith(`${m}|`)) rows.delete(k)
      return []
    }
    return []
  }
  return { query, rows }
}

describe('FEEDBACK_METRICS', () => {
  it('is separate from the summary-bound METRICS and never overlaps their names', () => {
    expect(FEEDBACK_METRICS).toEqual({ up: 'feedback_up', down: 'feedback_down' })
    const summaryNames = new Set(Object.values(METRICS))
    expect(summaryNames.has(FEEDBACK_METRICS.up)).toBe(false)
    expect(summaryNames.has(FEEDBACK_METRICS.down)).toBe(false)
  })

  it('accumulates 👍/👎 and shows up in readCounters alongside run counters', async () => {
    const { query } = fakeStore()
    await bumpCounter(query, 'm1', METRICS.created, 2)
    await bumpCounter(query, 'm1', FEEDBACK_METRICS.up, 1)
    await bumpCounter(query, 'm1', FEEDBACK_METRICS.up, 1)
    await bumpCounter(query, 'm1', FEEDBACK_METRICS.down, 1)
    expect(await readCounters(query, 'm1')).toEqual({ created: 2, feedback_up: 2, feedback_down: 1 })
  })
})

describe('bumpCounter', () => {
  it('creates then accumulates a counter (upsert)', async () => {
    const { query } = fakeStore()
    await bumpCounter(query, 'm1', METRICS.created, 2)
    await bumpCounter(query, 'm1', METRICS.created, 3)
    expect(await readCounters(query, 'm1')).toEqual({ created: 5 })
  })

  it('is a no-op for zero / non-finite / fractional-to-zero deltas', async () => {
    const q = vi.fn(async () => [])
    await bumpCounter(q, 'm1', 'created', 0)
    await bumpCounter(q, 'm1', 'created', Number.NaN)
    await bumpCounter(q, 'm1', 'created', Infinity)
    await bumpCounter(q, 'm1', 'created', 0.4) // trunc → 0
    expect(q).not.toHaveBeenCalled()
  })

  it('truncates a fractional delta toward zero', async () => {
    const { query } = fakeStore()
    await bumpCounter(query, 'm1', 'created', 2.9)
    expect(await readCounters(query, 'm1')).toEqual({ created: 2 })
  })

  it('emits an atomic upsert keyed by (member_id, name)', async () => {
    const q = vi.fn(async () => [])
    await bumpCounter(q, 'm1', 'created', 1)
    expect(q.mock.calls[0]![0]).toMatch(/ON CONFLICT \(member_id, name\) DO UPDATE SET value = metrics_counter\.value \+ EXCLUDED\.value/)
    expect(q.mock.calls[0]![1]).toEqual(['m1', 'created', 1])
  })
})

describe('bumpCounters', () => {
  it('bumps several names, skipping zero/non-finite', async () => {
    const { query } = fakeStore()
    await bumpCounters(query, 'm1', { created: 3, unmatched: 0, allocated: 2, manual: Number.NaN })
    expect(await readCounters(query, 'm1')).toEqual({ created: 3, allocated: 2 })
  })
})

describe('readCounters', () => {
  it('returns an empty map when nothing recorded', async () => {
    const { query } = fakeStore()
    expect(await readCounters(query, 'm1')).toEqual({})
  })

  it('coerces DB values to numbers', async () => {
    const query: QueryFn = async () => [{ name: 'created', value: '7' }]
    expect(await readCounters(query, 'm1')).toEqual({ created: 7 })
  })

  it('SELECT is scoped by member_id (guards against a dropped WHERE)', async () => {
    const q = vi.fn(async () => [])
    await readCounters(q, 'm1')
    expect(q.mock.calls[0]![0]).toMatch(/WHERE member_id = \$1/)
    expect(q.mock.calls[0]![1]).toEqual(['m1'])
  })
})

describe('resetCounters / deleteMetricsForPortal', () => {
  it('clears only the target portal, never another', async () => {
    const { query } = fakeStore()
    await bumpCounters(query, 'm1', { created: 5 })
    await bumpCounters(query, 'm2', { created: 9 })
    await resetCounters(query, 'm1')
    expect(await readCounters(query, 'm1')).toEqual({})
    expect(await readCounters(query, 'm2')).toEqual({ created: 9 }) // untouched
  })

  it('deleteMetricsForPortal purges the portal (uninstall always-purge)', async () => {
    const { query } = fakeStore()
    await bumpCounters(query, 'm1', { created: 5, allocated: 1 })
    await deleteMetricsForPortal(query, 'm1')
    expect(await readCounters(query, 'm1')).toEqual({})
  })

  it('DELETE is scoped by member_id (guards against a dropped WHERE)', async () => {
    const q = vi.fn(async () => [])
    await resetCounters(q, 'm1')
    expect(q.mock.calls[0]![0]).toMatch(/DELETE FROM metrics_counter WHERE member_id = \$1/)
    expect(q.mock.calls[0]![1]).toEqual(['m1'])
  })
})

describe('metricsFromSummary', () => {
  // Distinct value per field so a transposed mapping (e.g. allocated↔distributed) fails.
  const summary = {
    processed: 10, created: 11, notified: 12, skipped: 13, excluded: 24, unmatched: 14, recognized: 15,
    resolved: 16, allocatable: 17, ambiguous: 18, manual: 19, allocated: 20, distributed: 21,
    credits: 22, debits: 23
  }

  it('maps each counter to its OWN summary field (no transposition)', () => {
    expect(metricsFromSummary(summary)).toEqual({
      processed: 10, created: 11, notified: 12, unmatched: 14, recognized: 15,
      resolved: 16, allocated: 20, distributed: 21, ambiguous: 18, manual: 19
    })
  })

  it('deliberately excludes skipped / excluded / allocatable / credits / debits', () => {
    const out = metricsFromSummary(summary)
    for (const dropped of ['skipped', 'excluded', 'allocatable', 'credits', 'debits']) {
      expect(out).not.toHaveProperty(dropped)
    }
    expect(Object.keys(out)).toHaveLength(10)
  })

  it('names line up with the METRICS vocab', () => {
    expect(Object.keys(metricsFromSummary(summary)).sort()).toEqual(Object.values(METRICS).sort())
  })
})
