import type { QueryFn } from './tokenStore'

// TTL sweep for `portal_tombstone` (#77 retention). The ordering-guard tombstone
// (server/utils/tokenStore.ts) only needs to outlive a late/retried install job for the SAME
// uninstall — hours in practice, never months. Without a TTL the table would accrue one row per
// permanently-removed portal forever. A daily-ish sweep caps that growth. Pure over an injected
// QueryFn (DI + tests); no side effects beyond the DELETE.

export const DEFAULT_TOMBSTONE_TTL_DAYS = 30
const MAX_TOMBSTONE_TTL_DAYS = 365

/** Clamp `TOMBSTONE_TTL_DAYS` to [1, 365]; default 30. Blank/absent/non-numeric ⇒ default. Pure. */
export function resolveTombstoneDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TOMBSTONE_TTL_DAYS
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_TOMBSTONE_TTL_DAYS
  return Math.min(MAX_TOMBSTONE_TTL_DAYS, Math.max(1, Math.floor(n)))
}

/**
 * Delete `portal_tombstone` rows older than `days`. `deleted_ts` is Unix SECONDS (the B24 event
 * `ts`, see tokenStore), compared against `EXTRACT(EPOCH FROM now())` — unit-consistent. A stray
 * millisecond value (~1000× larger) would never satisfy the predicate → fail-safe (it is never
 * deleted early, only never swept). Returns the number of rows removed. Never throws on an empty
 * table (0). A `deleted_ts=0` tombstone (unknown event ts) is always older than the TTL → swept,
 * which is correct: a 0-ts row offers no real ordering protection anyway.
 */
export async function sweepExpiredTombstones(query: QueryFn, days: number): Promise<number> {
  const rows = await query(
    `DELETE FROM portal_tombstone WHERE deleted_ts < EXTRACT(EPOCH FROM now()) - $1 RETURNING member_id`,
    [days * 86_400]
  )
  return rows.length
}
