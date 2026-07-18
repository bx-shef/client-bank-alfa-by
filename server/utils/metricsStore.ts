// Per-portal durable metric counters over an injected `QueryFn` (unit-testable
// without a DB). Monotonic increments written best-effort by the crm-sync worker;
// read for the in-portal dashboard (#78). Distinct from `import_result` (which holds
// only the LATEST run) — these are lifetime totals that survive restarts and give the
// «сколько всего обработано / записано / не разнесено» the queue-depth snapshot can't.
//
// Borrowed in shape from the sibling ai-price-import app (server/utils/metricsStore.ts),
// adapted to our `QueryFn` (returns the rows array directly, not `{ rows }`) and to the
// payments domain vocabulary. Scoped per member_id — one portal never reads/resets
// another's counters. Ported here rather than lifted verbatim (their vocab is price-list
// specific: docs/lines/supplier-unmatched).

import type { QueryFn } from './tokenStore'

/** Canonical counter names accumulated per portal. Each is a key of the crm-sync run
 *  summary (server/queue/handlers.ts) — `metricsFromSummary` maps summary → these deltas,
 *  so a rename can't silently drift. NB: the summary also has `skipped` (redelivery noise),
 *  `excluded` (op skipped by an exclusion rule — PROCESSING §2 A2, not produced work),
 *  `allocatable` (⊇ `ambiguous`, would double-count), and `credits`/`debits` (a приход/расход
 *  split, not a lifetime total) — those are DELIBERATELY not accumulated here. */
export const METRICS = {
  processed: 'processed', // unique operations seen
  created: 'created', // CRM activities written
  notified: 'notified', // chat notifications sent
  unmatched: 'unmatched', // no company found for the account
  recognized: 'recognized', // ops with ≥1 recognized identifier in the purpose
  resolved: 'resolved', // ops whose intent resolved to ≥1 allocation candidate
  allocated: 'allocated', // allocation facts recorded
  distributed: 'distributed', // portal mutations applied (payment.pay / invoice stage)
  ambiguous: 'ambiguous', // allocation had >1 amount target
  manual: 'manual' // amount candidates but no exact match → manual queue
} as const

export type MetricName = typeof METRICS[keyof typeof METRICS]

/** The subset of a crm-sync run summary that becomes lifetime counters. Pure — maps each
 *  METRIC name to its summary field (identity keys, but explicit so a transposed field or
 *  a dropped counter fails a unit test, not silently in production). */
export function metricsFromSummary(
  summary: Record<MetricName, number>
): Record<MetricName, number> {
  return {
    [METRICS.processed]: summary.processed,
    [METRICS.created]: summary.created,
    [METRICS.notified]: summary.notified,
    [METRICS.unmatched]: summary.unmatched,
    [METRICS.recognized]: summary.recognized,
    [METRICS.resolved]: summary.resolved,
    [METRICS.allocated]: summary.allocated,
    [METRICS.distributed]: summary.distributed,
    [METRICS.ambiguous]: summary.ambiguous,
    [METRICS.manual]: summary.manual
  }
}

/** Increment a counter by `by` (row created if absent). Non-finite/zero ⇒ no-op.
 *  Atomic per row via `ON CONFLICT … DO UPDATE`. */
export async function bumpCounter(query: QueryFn, memberId: string, name: string, by: number): Promise<void> {
  const delta = Math.trunc(by)
  if (!Number.isFinite(delta) || delta === 0) return
  await query(
    `INSERT INTO metrics_counter (member_id, name, value) VALUES ($1, $2, $3)
     ON CONFLICT (member_id, name) DO UPDATE SET value = metrics_counter.value + EXCLUDED.value`,
    [memberId, name, delta]
  )
}

/** Bump several counters for a portal in one call (skips zero/non-finite deltas).
 *  Best-effort caller decides error handling; each bump is its own statement. */
export async function bumpCounters(query: QueryFn, memberId: string, deltas: Record<string, number>): Promise<void> {
  for (const [name, by] of Object.entries(deltas)) {
    await bumpCounter(query, memberId, name, by)
  }
}

/** Read all counters for a portal as a plain map (absent names omitted). */
export async function readCounters(query: QueryFn, memberId: string): Promise<Record<string, number>> {
  const rows = await query('SELECT name, value FROM metrics_counter WHERE member_id = $1', [memberId])
  const out: Record<string, number> = {}
  for (const r of rows) out[String(r.name)] = Number(r.value) || 0
  return out
}

/** Reset (delete) all counters for a portal — the operator's «сбросить метрики».
 *  Scoped to member_id so one portal never touches another's counters. */
export async function resetCounters(query: QueryFn, memberId: string): Promise<void> {
  await query('DELETE FROM metrics_counter WHERE member_id = $1', [memberId])
}

/** Purge a portal's counters on app uninstall (always-purge, like the other stores). */
export async function deleteMetricsForPortal(query: QueryFn, memberId: string): Promise<void> {
  await resetCounters(query, memberId)
}
