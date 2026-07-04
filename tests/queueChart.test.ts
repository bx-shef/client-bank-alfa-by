import { describe, expect, it } from 'vitest'
import {
  QUEUE_META,
  bucketSnapshot,
  bucketMsFor,
  seedSeries,
  windowPlan,
  backlog,
  emptySeries,
  legendRows,
  totalBacklog,
  type QueuesSnapshot
} from '~/utils/queueChart'

// Pure data-shaping for the queue monitor chart: build the live time-series from
// GET /api/queues snapshots (the chart component only renders). See docs/QUEUES.md.

function snap(queues: QueuesSnapshot['queues']): QueuesSnapshot {
  return { enabled: true, queues }
}

describe('backlog / totalBacklog', () => {
  it('backlog = waiting + active; completed/failed do not count', () => {
    expect(backlog({ waiting: 2, active: 1, completed: 99, failed: 5 })).toBe(3)
    expect(backlog(undefined)).toBe(0)
    expect(backlog({})).toBe(0)
  })

  it('never emits NaN/negatives from garbage counters', () => {
    expect(backlog({ waiting: Number.NaN, active: -3 })).toBe(0)
  })

  it('totalBacklog sums backlog across all known queues', () => {
    expect(totalBacklog(snap({ 'bank-fetch': { waiting: 2, active: 1 }, 'crm-sync': { waiting: 5 } }))).toBe(8)
  })
})

describe('emptySeries', () => {
  it('has one empty window per known queue', () => {
    const s = emptySeries()
    expect(Object.keys(s).sort()).toEqual(QUEUE_META.map(q => q.name).sort())
    expect(Object.values(s).every(a => a.length === 0)).toBe(true)
  })
})

describe('bucketSnapshot', () => {
  const bucket = 1000

  it('starts one bucket point per queue; pure (does not mutate prev)', () => {
    const prev = emptySeries()
    const next = bucketSnapshot(prev, snap({ 'bank-fetch': { waiting: 2, active: 1 } }), 1200, bucket, 60)
    expect(next['bank-fetch']).toEqual([[1200, 3]])
    expect(next['crm-sync']).toEqual([[1200, 0]]) // absent queue → 0
    expect(prev['bank-fetch']).toEqual([]) // prev untouched
  })

  it('same bucket: advances the live point to now, keeps the running MAX (no Y drop)', () => {
    let s = bucketSnapshot(emptySeries(), snap({ 'crm-sync': { waiting: 5 } }), 1100, bucket, 60)
    s = bucketSnapshot(s, snap({ 'crm-sync': { waiting: 2 } }), 1400, bucket, 60) // same bucket (floor 1), lower
    expect(s['crm-sync']).toEqual([[1400, 5]]) // one point, ts advanced, value = max(5,2)
    s = bucketSnapshot(s, snap({ 'crm-sync': { waiting: 9 } }), 1700, bucket, 60) // same bucket, higher
    expect(s['crm-sync']).toEqual([[1700, 9]])
  })

  it('crossing into a new bucket freezes the old point and starts a new one', () => {
    let s = bucketSnapshot(emptySeries(), snap({ 'crm-sync': { waiting: 5 } }), 1400, bucket, 60)
    s = bucketSnapshot(s, snap({ 'crm-sync': { waiting: 3 } }), 2200, bucket, 60) // bucket floor 2
    expect(s['crm-sync']).toEqual([[1400, 5], [2200, 3]]) // old frozen, new live
  })

  it('trims to cap (drops oldest buckets on the left)', () => {
    let s = emptySeries()
    for (let t = 0; t < 5; t++) s = bucketSnapshot(s, snap({ 'crm-sync': { waiting: t } }), t * bucket + 100, bucket, 3)
    // 5 distinct buckets → keep last 3 (buckets 2,3,4)
    expect(s['crm-sync']).toEqual([[2100, 2], [3100, 3], [4100, 4]])
  })

  it('ignores an unknown queue (only QUEUE_META queues are plotted)', () => {
    const next = bucketSnapshot(emptySeries(), snap({ 'some-future-queue': { waiting: 99 } }), 1000, bucket, 60)
    expect(next['some-future-queue']).toBeUndefined()
  })

  it('non-finite bucket/cap fall back to ≥1 (no NaN/empty)', () => {
    const next = bucketSnapshot(emptySeries(), snap({ 'crm-sync': { waiting: 1 } }), 1000, Number.NaN, Number.NaN)
    expect(next['crm-sync']).toEqual([[1000, 1]])
  })
})

describe('bucketMsFor', () => {
  it('≈ window/10 snapped to a nice value (10min→1min per the spec)', () => {
    expect(bucketMsFor(10 * 60_000)).toBe(60_000) // 10 min → 1 min
    expect(bucketMsFor(2 * 60_000)).toBe(10_000) // 2 min → 10 s
    expect(bucketMsFor(30 * 60_000)).toBe(180_000) // 30 min → 3 min
    expect(bucketMsFor(240 * 60_000)).toBe(1_200_000) // 4 h → 20 min
  })

  it('phone-halved spans stay reasonable (5 min → 30 s)', () => {
    expect(bucketMsFor(5 * 60_000)).toBe(30_000)
  })

  it('garbage → a sane default bucket', () => {
    expect(Number.isFinite(bucketMsFor(Number.NaN))).toBe(true)
    expect(bucketMsFor(Number.NaN)).toBe(60_000) // default window 10min → 1min
  })
})

describe('seedSeries', () => {
  it('backfills a full window (count points) per queue, flat at current backlog', () => {
    const s = seedSeries(snap({ 'crm-sync': { waiting: 2, active: 1 } }), 1000, 10, 3)
    expect(Object.keys(s).sort()).toEqual(QUEUE_META.map(q => q.name).sort())
    // count=3, step=10, now=1000 → timestamps 980, 990, 1000; value = backlog = 3
    expect(s['crm-sync']).toEqual([[980, 3], [990, 3], [1000, 3]])
    expect(s['b24-events']).toEqual([[980, 0], [990, 0], [1000, 0]]) // absent → 0
  })

  it('ends exactly at nowMs so the seam with the first appended point is continuous', () => {
    const s = seedSeries(snap({ 'crm-sync': { waiting: 4 } }), 5000, 100, 5)
    const pts = s['crm-sync']!
    expect(pts[pts.length - 1]![0]).toBe(5000)
    expect(pts.length).toBe(5)
  })

  it('clamps count and step to at least 1 (never empty / zero-width)', () => {
    const s = seedSeries(snap({ 'crm-sync': { waiting: 1 } }), 1000, 0, 0)
    expect(s['crm-sync']).toEqual([[1000, 1]]) // one point at now
  })

  it('non-finite count/step still yields real points (never empty / NaN timestamps)', () => {
    // A bad range select → Number('') = NaN can reach here; Math.max(1, NaN) = NaN
    // would slip past a bare clamp → empty windows / NaN x-values. Must fall back to 1.
    expect(seedSeries(snap({ 'crm-sync': { waiting: 1 } }), 1000, 10, Number.NaN)['crm-sync'])
      .toEqual([[1000, 1]])
    expect(seedSeries(snap({ 'crm-sync': { waiting: 1 } }), 1000, Number.NaN, 3)['crm-sync'])
      .toEqual([[998, 1], [999, 1], [1000, 1]]) // step NaN → falls back to 1, no NaN ts
  })

  it('tolerates a snapshot with no queues field (all-zero windows, no throw)', () => {
    const s = seedSeries({ enabled: false } as QueuesSnapshot, 1000, 10, 2)
    expect(s['crm-sync']).toEqual([[990, 0], [1000, 0]])
  })

  it('a new-bucket sample continues the seeded window one bucket to the right', () => {
    const seeded = seedSeries(snap({ 'crm-sync': { waiting: 1 } }), 1000, 10, 3) // buckets 98,99,100
    const next = bucketSnapshot(seeded, snap({ 'crm-sync': { waiting: 2 } }), 1010, 10, 3) // bucket 101
    expect(next['crm-sync']).toEqual([[990, 1], [1000, 1], [1010, 2]]) // slid one bucket, cap 3
  })
})

describe('windowPlan', () => {
  it('the four ranges: auto bucket + poll, ~10–12 points', () => {
    expect(windowPlan(2, false, 400)).toEqual({ windowMs: 120_000, bucketMs: 10_000, pollMs: 2000, pointCount: 12 })
    expect(windowPlan(10, false, 400)).toEqual({ windowMs: 600_000, bucketMs: 60_000, pollMs: 10_000, pointCount: 10 })
    expect(windowPlan(30, false, 400)).toEqual({ windowMs: 1_800_000, bucketMs: 180_000, pollMs: 10_000, pointCount: 10 })
    expect(windowPlan(240, false, 400)).toEqual({ windowMs: 14_400_000, bucketMs: 1_200_000, pollMs: 10_000, pointCount: 12 })
  })

  it('phone halves the span → smaller bucket, still ~10 points', () => {
    const desktop = windowPlan(10, false, 400)
    const phone = windowPlan(10, true, 400)
    expect(phone.windowMs).toBe(desktop.windowMs / 2)
    expect(phone).toEqual({ windowMs: 300_000, bucketMs: 30_000, pollMs: 5000, pointCount: 10 })
  })

  it('pollMs is clamped to 2–10 s (a few samples per bucket)', () => {
    for (const r of [2, 10, 30, 240]) {
      const p = windowPlan(r, false, 400)
      expect(p.pollMs).toBeGreaterThanOrEqual(2000)
      expect(p.pollMs).toBeLessThanOrEqual(10_000)
    }
  })

  it('maxPoints is a safety cap on pointCount', () => {
    expect(windowPlan(240, false, 5).pointCount).toBe(5) // would be 12, capped to 5
  })

  it('garbage inputs fall back to sane finite values (no NaN/Infinity/empty)', () => {
    const p = windowPlan(Number.NaN, false, 0)
    expect(Number.isFinite(p.windowMs)).toBe(true)
    expect(Number.isFinite(p.bucketMs)).toBe(true)
    expect(Number.isFinite(p.pollMs)).toBe(true)
    expect(p.pointCount).toBeGreaterThanOrEqual(2)
  })
})

describe('legendRows', () => {
  it('one row per queue in display order, current counters, 0 when absent', () => {
    const rows = legendRows(snap({ 'crm-sync': { waiting: 5, active: 1, completed: 38, failed: 2 } }))
    expect(rows.map(r => r.name)).toEqual(QUEUE_META.map(q => q.name))
    const crm = rows.find(r => r.name === 'crm-sync')!
    expect(crm).toMatchObject({ label: 'Запись в CRM', waiting: 5, active: 1, completed: 38, failed: 2 })
    const events = rows.find(r => r.name === 'b24-events')!
    expect(events).toMatchObject({ waiting: 0, active: 0, completed: 0, failed: 0 })
  })
})
