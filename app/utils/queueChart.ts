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
  // Guard non-finite inputs too: Math.floor(NaN)=NaN and Math.max(1,NaN)=NaN, which
  // would slip past a bare clamp and yield empty/NaN windows. A NaN can reach here via
  // the component (Number('') on a bad range select → NaN step). Fall back to 1.
  const n = Math.max(1, Math.floor(Number.isFinite(count) ? count : 1))
  const step = Math.max(1, Math.floor(Number.isFinite(stepMs) ? stepMs : 1))
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

/** The derived plan for the sliding window: visible span, point spacing, how many
 *  points fill it, and the update-animation duration. All numbers, all finite. */
export interface WindowPlan {
  /** Visible time span in ms (already halved on a phone). */
  windowMs: number
  /** Spacing between points = effective poll cadence in ms (memory-floored). */
  stepMs: number
  /** Points that fill the window — seed size and trim cap (≥2, ≤ maxPoints). */
  pointCount: number
  /** ECharts update-animation duration in ms. */
  durationMs: number
}

/** The slowest an update tween runs. Matching the tween to the step gives a continuous
 *  right-to-left glide at short (narrow-range) steps — the smooth conveyor. But a wide
 *  range's step is tens of seconds over ~maxPoints vertices; tweening that whole span
 *  every tick would repaint thousands of vertices every frame forever (CPU). Capping at
 *  5 s makes wide ranges PAINT-then-REST (a short glide, then idle until the next tick)
 *  while narrow ranges (step ≤ 5 s) still glide continuously. */
const MAX_ANIM_MS = 5000

/**
 * Derive the sliding-window plan from the operator's choices. Pure (no DOM/refs) so it
 * is unit-testable and the component just consumes it.
 *
 * - `stepMs` is the SELECTED poll cadence, but floored so the full window fits within
 *   `maxPoints` (memory ceiling) — at wide ranges the step coarsens and the poll knob
 *   effectively no-ops (you can't hold 2 s resolution across 4 h without huge memory).
 * - On a phone the span is halved (narrower axis, fewer/legible points).
 * - Non-finite / non-positive inputs fall back to sane defaults (never NaN/Infinity).
 */
export function windowPlan(
  rangeMin: number,
  pollSec: number,
  isNarrow: boolean,
  maxPoints: number
): WindowPlan {
  const cap = Math.max(1, Math.floor(Number.isFinite(maxPoints) ? maxPoints : 1))
  const rangeM = Number.isFinite(rangeMin) && rangeMin > 0 ? rangeMin : 10
  const pollS = Number.isFinite(pollSec) && pollSec > 0 ? pollSec : 5
  const windowMs = rangeM * 60_000 * (isNarrow ? 0.5 : 1)
  const wanted = Math.max(1000, Math.round(pollS * 1000))
  const memFloor = Math.ceil(windowMs / cap)
  const stepMs = Math.max(wanted, memFloor)
  const pointCount = Math.max(2, Math.round(windowMs / stepMs))
  const durationMs = Math.min(MAX_ANIM_MS, stepMs)
  return { windowMs, stepMs, pointCount, durationMs }
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
