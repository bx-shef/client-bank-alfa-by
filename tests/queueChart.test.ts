import { describe, expect, it } from 'vitest'
import {
  QUEUE_META,
  appendSnapshot,
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

describe('appendSnapshot', () => {
  it('appends one [ts, backlog] point per queue, is pure (does not mutate prev)', () => {
    const prev = emptySeries()
    const next = appendSnapshot(prev, snap({ 'bank-fetch': { waiting: 2, active: 1 } }), 1000, 60)
    expect(next['bank-fetch']).toEqual([[1000, 3]])
    expect(next['crm-sync']).toEqual([[1000, 0]]) // absent queue → 0
    expect(prev['bank-fetch']).toEqual([]) // prev untouched
  })

  it('slides the window: drops the oldest point past maxPoints', () => {
    let s = emptySeries()
    for (let t = 1; t <= 5; t++) s = appendSnapshot(s, snap({ 'crm-sync': { waiting: t } }), t, 3)
    expect(s['crm-sync']).toEqual([[3, 3], [4, 4], [5, 5]]) // last 3 only
  })

  it('ignores an unknown queue in the snapshot (only QUEUE_META queues are plotted)', () => {
    const next = appendSnapshot(emptySeries(), snap({ 'some-future-queue': { waiting: 99 } }), 1000, 60)
    expect(Object.keys(next).sort()).toEqual(QUEUE_META.map(q => q.name).sort())
    expect(next['some-future-queue']).toBeUndefined()
  })

  it('ignores a duplicate timestamp at the tail (double poll)', () => {
    let s = appendSnapshot(emptySeries(), snap({ 'crm-sync': { waiting: 1 } }), 1000, 60)
    s = appendSnapshot(s, snap({ 'crm-sync': { waiting: 9 } }), 1000, 60) // same ts
    expect(s['crm-sync']).toEqual([[1000, 1]])
  })

  it('maxPoints < 1 is clamped to 1 (keeps only the newest point)', () => {
    let s = appendSnapshot(emptySeries(), snap({ 'crm-sync': { waiting: 1 } }), 1, 0)
    s = appendSnapshot(s, snap({ 'crm-sync': { waiting: 2 } }), 2, 0)
    expect(s['crm-sync']).toEqual([[2, 2]])
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

  it('an appended point continues the seeded window one step to the right', () => {
    const seeded = seedSeries(snap({ 'crm-sync': { waiting: 1 } }), 1000, 10, 3)
    const next = appendSnapshot(seeded, snap({ 'crm-sync': { waiting: 2 } }), 1010, 3)
    expect(next['crm-sync']).toEqual([[990, 1], [1000, 1], [1010, 2]]) // slid one step, cap 3
  })
})

describe('windowPlan', () => {
  it('default (10min, 5s, desktop, cap 400): step=poll, ~120 points, cont. glide', () => {
    expect(windowPlan(10, 5, false, 400)).toEqual({
      windowMs: 600_000, stepMs: 5000, pointCount: 120, durationMs: 5000
    })
  })

  it('memory floor bites at wide range: 4h/2s caps points, coarsens step (poll no-ops)', () => {
    // 14.4M ms / 400 cap → floor 36000 ms wins over the 2s wanted; points pinned to 400.
    expect(windowPlan(240, 2, false, 400)).toEqual({
      windowMs: 14_400_000, stepMs: 36_000, pointCount: 400, durationMs: 5000
    })
  })

  it('phone halves the span → exactly half the points of the desktop case', () => {
    const desktop = windowPlan(10, 5, false, 400)
    const phone = windowPlan(10, 5, true, 400)
    expect(phone.windowMs).toBe(desktop.windowMs / 2)
    expect(phone.pointCount).toBe(desktop.pointCount / 2) // 120 → 60
    expect(phone).toMatchObject({ windowMs: 300_000, stepMs: 5000, pointCount: 60 })
  })

  it('phone + wide range still respects the point cap', () => {
    // 7.2M ms / 400 → floor 18000 ms.
    expect(windowPlan(240, 2, true, 400)).toEqual({
      windowMs: 7_200_000, stepMs: 18_000, pointCount: 400, durationMs: 5000
    })
  })

  it('slow poll: 15s step, capped 5s glide (paint-then-rest), ~40 points at 10min', () => {
    expect(windowPlan(10, 15, false, 400)).toEqual({
      windowMs: 600_000, stepMs: 15_000, pointCount: 40, durationMs: 5000
    })
  })

  it('durationMs never exceeds the 5s cap regardless of step', () => {
    for (const [r, p] of [[10, 2], [30, 5], [60, 15], [240, 2]] as const) {
      expect(windowPlan(r, p, false, 400).durationMs).toBeLessThanOrEqual(5000)
    }
  })

  it('sub-second poll is floored to 1s (never a runaway fetch loop)', () => {
    // Large cap so the memory floor doesn't dominate — isolates the poll floor.
    expect(windowPlan(10, 0.5, false, 100_000).stepMs).toBe(1000)
  })

  it('garbage inputs fall back to sane finite values (no NaN/Infinity/empty)', () => {
    const p = windowPlan(Number.NaN, Number.NaN, false, 0)
    expect(Number.isFinite(p.windowMs)).toBe(true)
    expect(Number.isFinite(p.stepMs)).toBe(true)
    expect(p.pointCount).toBeGreaterThanOrEqual(2)
    expect(p.durationMs).toBeLessThanOrEqual(5000)
  })

  it('pointCount never overshoots the cap at a boundary combo', () => {
    // Any range/poll: round(windowMs/stepMs) ≤ cap because stepMs ≥ ceil(windowMs/cap).
    for (const [r, p, cap] of [[37, 3, 250], [123, 7, 500], [11, 2, 300]] as const) {
      expect(windowPlan(r, p, false, cap).pointCount).toBeLessThanOrEqual(cap)
    }
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
