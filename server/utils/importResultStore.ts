// Persistent «last import run» per portal (#5), so the in-portal UI can show a real
// result (operations / activities created / chat notified) instead of a mock. ONE row
// per portal (member_id PK): each crm-sync job UPSERTS it with that run's summary, so
// the stored value is always the MOST RECENT run. Pure over an injected `QueryFn` —
// unit-testable without a DB. Schema: `import_result` in server/db/client.ts. Uninstall
// purges it (like the other per-portal stores). The stored shape mirrors the client
// contract `ImportRunSummary` (app/types/importStatus.ts), minus the reserved
// `nextSyncAt` (the cron plan, not a stored fact).

import type { ImportRunSummary, ImportState } from '../../app/types/importStatus'
import type { QueryFn } from './tokenStore'

const VALID_STATES: readonly ImportState[] = ['never', 'running', 'ok', 'error']

/** Coerce a stored `state` string to a valid `ImportState` (defensive — the column is
 *  written only by us, but never trust a DB value blindly). Unknown → 'never'. */
function coerceState(v: unknown): ImportState {
  return typeof v === 'string' && (VALID_STATES as readonly string[]).includes(v) ? v as ImportState : 'never'
}

/** Coerce the stored `errors` (jsonb) to a string[] — drops non-strings, empty on junk. */
function coerceErrors(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : []
}

/** Read the last import run for a portal, or null if none has been recorded yet. */
export async function getImportResult(query: QueryFn, memberId: string): Promise<ImportRunSummary | null> {
  const rows = await query(
    `SELECT state, last_sync_at, operations, activities_created, chat_notified, errors
     FROM import_result WHERE member_id = $1`,
    [memberId]
  )
  const row = rows[0]
  if (!row) return null
  const lastSyncAt = row.last_sync_at
  return {
    state: coerceState(row.state),
    lastSyncAt: lastSyncAt == null ? null : new Date(lastSyncAt as string | number | Date).toISOString(),
    operations: Number(row.operations) || 0,
    activitiesCreated: Number(row.activities_created) || 0,
    chatNotified: Number(row.chat_notified) || 0,
    errors: coerceErrors(row.errors)
  }
}

/**
 * Upsert the portal's last import run summary (write-latest, one row per member_id).
 * `lastSyncAt` is an ISO string (stamped by the caller/worker, not this pure store).
 * `errors` is serialized to jsonb. A later run overwrites the previous one.
 */
export async function saveImportResult(query: QueryFn, memberId: string, summary: ImportRunSummary): Promise<void> {
  await query(
    `INSERT INTO import_result
       (member_id, state, last_sync_at, operations, activities_created, chat_notified, errors, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
     ON CONFLICT (member_id) DO UPDATE SET
       state = EXCLUDED.state,
       last_sync_at = EXCLUDED.last_sync_at,
       operations = EXCLUDED.operations,
       activities_created = EXCLUDED.activities_created,
       chat_notified = EXCLUDED.chat_notified,
       errors = EXCLUDED.errors,
       updated_at = now()`,
    [
      memberId,
      summary.state,
      summary.lastSyncAt,
      summary.operations,
      summary.activitiesCreated,
      summary.chatNotified,
      JSON.stringify(summary.errors ?? [])
    ]
  )
}

/** Purge the portal's import result on ONAPPUNINSTALL (uninstall always erases
 *  everything for the portal). Idempotent. */
export async function deleteImportResultForPortal(query: QueryFn, memberId: string): Promise<void> {
  await query(`DELETE FROM import_result WHERE member_id = $1`, [memberId])
}
