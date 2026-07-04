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
 * Fold one poll snapshot into the current TIME BUCKET of every queue's window (not one
 * point per poll — one point per `bucketMs` interval). The live (rightmost) bucket keeps
 * a running MAX and tracks `tsMs`; when `tsMs` crosses into a new bucket a fresh point
 * starts, freezing the previous one. Older buckets never change → they slide left without
 * ever moving in Y. Aggregating by max surfaces the peak backlog in each interval (an
 * average would hide short spikes). Pure: returns a NEW SeriesPoints. Trims to `cap`.
 *
 * A point's bucket is derived from its own timestamp (`floor(ts/bucketMs)`), so no extra
 * per-point state is needed: the live point's ts is always inside its bucket.
 */
export function bucketSnapshot(
  prev: SeriesPoints,
  snapshot: QueuesSnapshot,
  tsMs: number,
  bucketMs: number,
  cap: number
): SeriesPoints {
  const bucket = Math.max(1, Math.floor(Number.isFinite(bucketMs) ? bucketMs : 1))
  const limit = Math.max(1, Math.floor(Number.isFinite(cap) ? cap : 1))
  const b = Math.floor(tsMs / bucket)
  const next: SeriesPoints = {}
  for (const q of QUEUE_META) {
    const points = (prev[q.name] ?? []).slice()
    const last = points[points.length - 1]
    const value = backlog(snapshot.queues?.[q.name])
    if (last && Math.floor(last[0] / bucket) === b) {
      // Same bucket: advance the live point to now, keep the running max.
      points[points.length - 1] = [tsMs, Math.max(last[1], value)]
    } else {
      points.push([tsMs, value])
    }
    while (points.length > limit) points.shift()
    next[q.name] = points
  }
  return next
}

/** Nice bucket widths (ms) the chart discretises time into — 5 s … 30 min. */
const BUCKET_LADDER_MS = [5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 180e3, 300e3, 600e3, 900e3, 1_200e3, 1_800e3]

/**
 * Pick a "nice" bucket width for a window so the chart shows ~10 evenly-spaced points:
 * the ladder value nearest `windowMs / 10` (ties → the smaller, for a bit more detail).
 * E.g. 10 min → 1 min, 30 min → 3 min, 2 min → 10 s, 4 h → 20 min. Pure.
 */
export function bucketMsFor(windowMs: number): number {
  const target = (Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 600_000) / 10
  let best = BUCKET_LADDER_MS[0]!
  let bestDiff = Infinity
  for (const b of BUCKET_LADDER_MS) {
    const d = Math.abs(b - target)
    if (d < bestDiff) {
      bestDiff = d
      best = b
    }
  }
  return best
}

/** The derived plan for the sliding window: visible span, bucket width, poll cadence,
 *  and how many buckets fill the window. All numbers, all finite. (Motion is a rAF
 *  axis-slide in the component, not an ECharts tween, so there's no animation duration.) */
export interface WindowPlan {
  /** Visible time span in ms (already halved on a phone). */
  windowMs: number
  /** Discretisation: one plotted point per this interval. */
  bucketMs: number
  /** How often to poll the endpoint — a few times per bucket, so the live bucket stays
   *  fresh without hammering (clamped 2–10 s). */
  pollMs: number
  /** Buckets that fill the window — seed size / trim cap basis (≥2, ≤ maxPoints). */
  pointCount: number
}

/**
 * Derive the plan from the selected range. Pure (no DOM/refs) so it is unit-testable and
 * the component just consumes it.
 *
 * - `bucketMs` is auto (≈window/10, snapped to a nice value) — the operator only picks the
 *   range; discretisation and poll cadence follow.
 * - `pollMs` is a few times finer than the bucket (clamped 2–10 s) so every bucket gets
 *   several samples and the live bucket updates smoothly.
 * - On a phone the span is halved (narrower axis → smaller bucket, fewer/legible points).
 * - `maxPoints` is a safety cap on point count (buckets already keep it ~10–14).
 * - Non-finite / non-positive inputs fall back to sane defaults (never NaN/Infinity).
 */
export function windowPlan(
  rangeMin: number,
  isNarrow: boolean,
  maxPoints: number
): WindowPlan {
  const cap = Math.max(2, Math.floor(Number.isFinite(maxPoints) ? maxPoints : 2))
  const rangeM = Number.isFinite(rangeMin) && rangeMin > 0 ? rangeMin : 10
  const windowMs = rangeM * 60_000 * (isNarrow ? 0.5 : 1)
  const bucketMs = bucketMsFor(windowMs)
  const pollMs = Math.min(10_000, Math.max(2000, Math.round(bucketMs / 6)))
  const pointCount = Math.min(cap, Math.max(2, Math.round(windowMs / bucketMs)))
  return { windowMs, bucketMs, pollMs, pointCount }
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
