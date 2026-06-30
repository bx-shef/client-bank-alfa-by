/**
 * Status of the statement-import process, surfaced in the in-portal UI so the
 * user can see the app is alive and working. The live value comes from the
 * backend poller (#5); the frontend only renders it (mock until then).
 */

/** Overall state of the import. */
export type ImportState
  = | 'never' // never run yet (just installed)
    | 'running' // a sync is in progress
    | 'ok' // last sync finished cleanly
    | 'error' // last sync failed

/** Summary of the most recent import run. */
export interface ImportRunSummary {
  state: ImportState
  /** ISO timestamp of the last finished sync, or null if never run. */
  lastSyncAt: string | null
  /** Operations fetched from the bank in the last run. */
  operations: number
  /** CRM activities created from those operations. */
  activitiesCreated: number
  /** Chat notifications sent for incoming payments. */
  chatNotified: number
  /** Human-readable errors from the last run (empty when clean). */
  errors: string[]
  /** ISO timestamp of the next scheduled sync, if known. Reserved for a future
   *  "next sync in …" hint — not rendered yet (backend poller, #5). */
  nextSyncAt?: string | null
}
