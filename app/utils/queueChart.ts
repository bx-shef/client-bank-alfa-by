// Pure data-shaping for the queue monitor chart (app/components/QueueMonitor.vue).
// GET /api/ops/queues (the operator monitor source; same shape as /api/queues)
// returns only a CURRENT snapshot per queue (getJobCounts: waiting/active/completed/
// failed/delayed/paused) — no history/rates like the RabbitMQ example. So the live
// time-series is built client-side: each poll appends
// one point per queue to a sliding window. This module holds that logic (no DOM,
// no ECharts) so it is unit-testable; the component only renders. See docs/QUEUES.md.

/** One queue's counters — the shape BullMQ's getJobCounts() returns. */
export interface QueueCounts {
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
  paused: number
}

/** The queue-counts response (GET /api/ops/queues; same shape as /api/queues).
 *  Mirror of the server `QueuesSnapshot` in server/queue/stats.ts. */
export interface QueuesSnapshot {
  enabled: boolean
  queues: Record<string, Partial<QueueCounts>>
}

/** Presentation metadata for the four queues, in display order. `crm-sync` is the
 * "main" queue (drawn with an area fill), matching the RabbitMQ example's isMain. */
export interface QueueMeta {
  name: string
  label: string
  color: string
  main?: boolean
}

export const QUEUE_META: readonly QueueMeta[] = [
  { name: 'b24-events', label: 'События B24', color: '#8b5cf6' },
  { name: 'bank-fetch', label: 'Опрос банка', color: '#3b82f6' },
  { name: 'file-parse', label: 'Разбор файла', color: '#f59e0b' },
  { name: 'crm-sync', label: 'Запись в CRM', color: '#10b981', main: true }
] as const

/** A finite non-negative integer from an unknown counter value (never NaN). */
function count(v: number | undefined): number {
  return Number.isFinite(v) && (v as number) > 0 ? Math.floor(v as number) : 0
}

/** Backlog = ждут + в работе — the "live length" of a queue (analog of RabbitMQ
 * `messages`). `completed`/`failed` are cumulative totals, not backlog. */
export function backlog(counts: Partial<QueueCounts> | undefined): number {
  return count(counts?.waiting) + count(counts?.active)
}

/** A per-queue sliding window of `[timestampMs, backlog]` points. */
export type SeriesPoints = Record<string, Array<[number, number]>>

/** Empty series (one entry per known queue) — the initial chart state. */
export function emptySeries(): SeriesPoints {
  const out: SeriesPoints = {}
  for (const q of QUEUE_META) out[q.name] = []
  return out
}

/**
 * Backfill a FULL window from a single snapshot, so the chart starts full and slides
 * immediately (no "grow from empty / clamped first date"). Produces `count` points
 * per queue at the snapshot's current backlog, timestamps `nowMs-(count-1)*stepMs …
 * nowMs`. The endpoint gives only a current snapshot (no history), so the seeded past
 * is a flat line at the current value — real data then flows in from the right. Pure.
 */
export function seedSeries(
  snapshot: QueuesSnapshot,
  nowMs: number,
  stepMs: number,
  count: number
): SeriesPoints {
  const n = Math.max(1, Math.floor(count))
  const step = Math.max(1, Math.floor(stepMs))
  const out: SeriesPoints = {}
  for (const q of QUEUE_META) {
    const value = backlog(snapshot.queues?.[q.name])
    const points: Array<[number, number]> = []
    for (let i = n - 1; i >= 0; i--) points.push([nowMs - i * step, value])
    out[q.name] = points
  }
  return out
}

/**
 * Append one snapshot as a new point (`[tsMs, backlog]`) to every queue's window,
 * trimming to `maxPoints` (drops the oldest on the left — the running-tape effect).
 * Pure: returns a NEW SeriesPoints, does not mutate `prev`. A point with a
 * timestamp already present at the tail is ignored (dedups a double-poll).
 */
export function appendSnapshot(
  prev: SeriesPoints,
  snapshot: QueuesSnapshot,
  tsMs: number,
  maxPoints: number
): SeriesPoints {
  const cap = Math.max(1, Math.floor(maxPoints))
  const next: SeriesPoints = {}
  for (const q of QUEUE_META) {
    const points = (prev[q.name] ?? []).slice()
    const last = points[points.length - 1]
    if (!last || last[0] !== tsMs) {
      points.push([tsMs, backlog(snapshot.queues?.[q.name])])
    }
    while (points.length > cap) points.shift()
    next[q.name] = points
  }
  return next
}

/** One legend-table row: current counters for a queue (0 when absent/disabled). */
export interface QueueLegendRow {
  name: string
  label: string
  color: string
  waiting: number
  active: number
  completed: number
  failed: number
}

/** Legend rows for all queues, in display order, from a snapshot. */
export function legendRows(snapshot: QueuesSnapshot): QueueLegendRow[] {
  return QUEUE_META.map((q) => {
    const c = snapshot.queues?.[q.name]
    return {
      name: q.name,
      label: q.label,
      color: q.color,
      waiting: count(c?.waiting),
      active: count(c?.active),
      completed: count(c?.completed),
      failed: count(c?.failed)
    }
  })
}

/** Total backlog across all queues (chart subtitle / headline number). */
export function totalBacklog(snapshot: QueuesSnapshot): number {
  return QUEUE_META.reduce((sum, q) => sum + backlog(snapshot.queues?.[q.name]), 0)
}
