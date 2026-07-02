// Persistent {dedupKey → activityId} store for CRM activities (issue #9).
//
// crm-sync must not create a second Bitrix24 activity for an operation it already
// wrote. The in-batch Set in handleCrmSyncJob only dedupes within one job; it does
// NOT survive a worker restart or at-least-once redelivery of the whole job (crash
// after partial writes). This table is the durable guard: before writing an
// activity, look it up (`getActivityId`); after a successful write, record it
// (`rememberActivity`). Keyed per portal (member_id) so distinct portals importing
// the same account don't collide. Pure over an injected `QueryFn` — unit-testable
// without a DB. Schema: `activity_dedup` in server/db/client.ts (SCHEMA_SQL).
//
// Residual race (documented, not fully closed here): the activity creation in B24
// and `rememberActivity` are not one transaction, so two workers concurrently
// processing the same operation could both miss `getActivityId` and both create an
// activity (only one row is then remembered — INSERT ... ON CONFLICT DO NOTHING).
// The activity's embedded origin token (app/utils/activity.ts) remains the
// secondary, B24-side dedup signal. Serializing per-portal work removes the race
// entirely; that's a queue-topology concern, out of scope for the store.

import type { QueryFn } from './tokenStore'

/** The account|docId key of an operation (from app/utils/statement.ts `dedupKey`). */
export type DedupKey = string

/** Look up the activity id already written for `dedupKey` in this portal, or null. */
export async function getActivityId(query: QueryFn, memberId: string, dedupKey: DedupKey): Promise<string | null> {
  const rows = await query(
    `SELECT activity_id FROM activity_dedup WHERE member_id = $1 AND dedup_key = $2`,
    [memberId, dedupKey]
  )
  return rows[0] ? String(rows[0].activity_id) : null
}

/**
 * Record the activity id written for an operation. Write-once per (portal, key):
 * `ON CONFLICT DO NOTHING` keeps the first id, so a redelivered job that re-creates
 * (it shouldn't, if it checks `getActivityId` first) can't clobber the mapping.
 * Returns true if this call inserted the row, false if one already existed.
 */
export async function rememberActivity(
  query: QueryFn,
  memberId: string,
  dedupKey: DedupKey,
  activityId: string
): Promise<boolean> {
  const rows = await query(
    `INSERT INTO activity_dedup (member_id, dedup_key, activity_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (member_id, dedup_key) DO NOTHING
     RETURNING activity_id`,
    [memberId, dedupKey, activityId]
  )
  return rows.length > 0
}

/** Purge all dedup rows for a portal on ONAPPUNINSTALL — uninstall always erases
 * everything for the portal (same policy as the token store). Idempotent. */
export async function deleteDedupForPortal(query: QueryFn, memberId: string): Promise<void> {
  await query(`DELETE FROM activity_dedup WHERE member_id = $1`, [memberId])
}
