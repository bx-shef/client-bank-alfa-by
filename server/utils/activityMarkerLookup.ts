// B24-side dedup lookup for CRM activities (#259 Phase B): find an activity we already
// wrote by our external-source marker (ORIGINATOR_ID + ORIGIN_ID), so crm-sync can skip a
// re-write without the activity_dedup store. Pure over the injected `call` — unit-testable
// with a fake. Used only on the CONFIGURABLE-activity path (crm.activity.configurable.add
// stamps the marker; the simple todo activity has no such field — see docs/PROCESSING.md §1).

import type { RestCall } from './companyLookup'

/** REST method that lists CRM activities by filter (with the caller's permissions). */
export const ACTIVITY_LIST_METHOD = 'crm.activity.list'

/**
 * Find the id of an activity carrying our marker, or null if none exists yet.
 *
 * The (ORIGINATOR_ID, ORIGIN_ID) PAIR is mandatory: crm.activity.list returns ANY portal
 * activity matching the filter, so ORIGIN_ID alone could match a client's own imported
 * activity (or another provider's) that coincidentally shares the id → a silent dedup skip
 * (a legitimately-new operation would be missed). Scoping by our distinctive ORIGINATOR_ID
 * namespace prevents that. An empty originatorId/originId returns null WITHOUT a REST call —
 * an empty filter would list every activity (and never match a specific op). A transport
 * error from `call` propagates (BullMQ retries the job), like companyLookup.
 */
export async function findActivityByMarker(originatorId: string, originId: string, call: RestCall): Promise<string | null> {
  if (!originatorId || !originId) return null
  const resp = await call(ACTIVITY_LIST_METHOD, {
    filter: { ORIGINATOR_ID: originatorId, ORIGIN_ID: originId },
    select: ['ID'],
    order: { ID: 'ASC' },
    start: 0
  })
  const result = (resp as Record<string, unknown>)?.result
  if (!Array.isArray(result) || result.length === 0) return null
  const first = result[0] as Record<string, unknown>
  const id = first?.ID ?? first?.id
  return id !== undefined && id !== null && `${id}` !== '' ? `${id}` : null
}
