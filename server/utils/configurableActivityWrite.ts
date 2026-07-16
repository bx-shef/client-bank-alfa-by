// Write a CONFIGURABLE CRM activity (crm.activity.configurable.add) for one operation
// over a portal-bound RestCall (#259). This is the SOLE activity carrier crm-sync writes:
// unlike the old crm.activity.todo.add, a configurable activity carries an
// ORIGINATOR_ID/ORIGIN_ID marker, so dedup lives in B24 (see activityMarkerLookup.ts) with
// no local store. Pure over the injected `call` — unit-testable with a fake. The params are
// built by the shared, tested builder in app/utils/configurableActivity.ts; this module only
// does the REST call + result extraction.

import type { StatementItem } from '../../app/types/statement'
import { buildConfigurableActivity } from '../../app/utils/configurableActivity'
import type { RestCall } from './companyLookup'

/** REST method that adds a configurable activity to the CRM timeline. */
export const CONFIGURABLE_ACTIVITY_ADD_METHOD = 'crm.activity.configurable.add'

/** Pull the created activity id out of the REST response. configurable.add nests it as
 *  `{result:{activity:{id}}}` (unlike todo.add's `{result:{id}}`). String id, or null on
 *  an error/empty/malformed body. */
export function extractConfigurableActivityId(resp: Record<string, unknown>): string | null {
  const result = resp?.result
  if (!result || typeof result !== 'object') return null
  const activity = (result as Record<string, unknown>).activity
  if (!activity || typeof activity !== 'object') return null
  const id = (activity as Record<string, unknown>).id
  return id !== undefined && id !== null && `${id}` !== '' ? `${id}` : null
}

/**
 * Create the configurable activity for `item` attached to CRM company `companyId` and
 * return its new id, or null if the API returned no id. The caller guarantees a non-empty
 * `companyId` (an activity needs an owner). A transport error from `call` propagates
 * (BullMQ then retries the job). ⚠ crm.activity.configurable.add is OAuth/app-context only.
 */
export async function writeConfigurableActivityViaRest(item: StatementItem, companyId: string, call: RestCall): Promise<string | null> {
  const params = buildConfigurableActivity(item, { id: Number(companyId) })
  const resp = await call(CONFIGURABLE_ACTIVITY_ADD_METHOD, params as unknown as Record<string, unknown>)
  return extractConfigurableActivityId(resp)
}
