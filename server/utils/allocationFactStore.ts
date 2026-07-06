// Persistent «платёж → сущность» allocation record (#109, PROCESSING.md §1/§2).
//
// Distinct from `activity_dedup` (op-level «wrote an activity»): this records that a
// payment was ALLOCATED against a specific target (invoice / deal payment / deal /
// smart-process element) and lets a сторно flip that fact to `reverted` — the row is
// NOT deleted, so history survives. Idempotent per (portal, factKey): a redelivered
// batch or reimport of the same statement does not allocate twice. Keyed per portal
// (member_id) so distinct portals never collide. `factKey` is app/utils/allocation
// `allocationFactKey` (payment dedup key + target kind + id); `target_kind`/`target_id`
// are also stored as columns so the target is queryable without splitting the key.
// Pure over an injected `QueryFn` — unit-testable without a DB. Schema:
// `allocation_fact` in server/db/client.ts (SCHEMA_SQL). Uninstall purges it.

import type { QueryFn } from './tokenStore'

/** `allocated` = разнесён; `reverted` = откат (сторно). */
export type AllocationFactStatus = 'allocated' | 'reverted'

/** A stored allocation fact. */
export interface AllocationFact {
  status: AllocationFactStatus
  targetKind: string
  targetId: string
}

/** Read the allocation fact for a (portal, factKey), or null if none exists. */
export async function getAllocationFact(
  query: QueryFn,
  memberId: string,
  factKey: string
): Promise<AllocationFact | null> {
  const rows = await query(
    `SELECT status, target_kind, target_id FROM allocation_fact
     WHERE member_id = $1 AND fact_key = $2`,
    [memberId, factKey]
  )
  const row = rows[0]
  if (!row) return null
  return {
    status: String(row.status) === 'reverted' ? 'reverted' : 'allocated',
    targetKind: String(row.target_kind),
    targetId: String(row.target_id)
  }
}

/**
 * Record that a payment was allocated against a target. Write-once per (portal,
 * factKey): `ON CONFLICT DO NOTHING` keeps the FIRST fact, so a redelivered job /
 * reimport can't create a duplicate or overwrite a later `reverted` status back to
 * `allocated`. Returns true if this call inserted the row, false if one existed.
 */
export async function recordAllocation(
  query: QueryFn,
  memberId: string,
  factKey: string,
  targetKind: string,
  targetId: string
): Promise<boolean> {
  const rows = await query(
    `INSERT INTO allocation_fact (member_id, fact_key, target_kind, target_id, status)
     VALUES ($1, $2, $3, $4, 'allocated')
     ON CONFLICT (member_id, fact_key) DO NOTHING
     RETURNING fact_key`,
    [memberId, factKey, targetKind, targetId]
  )
  return rows.length > 0
}

/**
 * Flip an allocated fact to `reverted` on сторно (only an `allocated` row is
 * touched — reverting twice is a no-op). Returns true if a row was updated, false
 * when there was no matching allocated fact. `updated_at` is bumped.
 */
export async function revertAllocation(
  query: QueryFn,
  memberId: string,
  factKey: string
): Promise<boolean> {
  const rows = await query(
    `UPDATE allocation_fact SET status = 'reverted', updated_at = now()
     WHERE member_id = $1 AND fact_key = $2 AND status = 'allocated'
     RETURNING fact_key`,
    [memberId, factKey]
  )
  return rows.length > 0
}

/** Purge all allocation facts for a portal on ONAPPUNINSTALL — uninstall always
 * erases everything for the portal (same policy as the other stores). Idempotent. */
export async function deleteFactsForPortal(query: QueryFn, memberId: string): Promise<void> {
  await query(`DELETE FROM allocation_fact WHERE member_id = $1`, [memberId])
}
