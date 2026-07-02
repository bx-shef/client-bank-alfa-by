// Write a universal CRM activity (crm.activity.todo.add) for one operation over a
// portal-bound RestCall. Pure over the injected `call` — unit-testable with a fake.
// The activity params are built by the shared, tested builder in app/utils/activity.ts
// (buildTodoActivity); this module only does the REST call + result extraction.

import type { StatementItem } from '../../app/types/statement'
import { buildTodoActivity } from '../../app/utils/activity'
import type { RestCall } from './companyLookup'

/** REST method that adds a universal (todo) activity to the CRM timeline. */
export const ACTIVITY_ADD_METHOD = 'crm.activity.todo.add'

/** Pull the created activity id out of the REST response (`{result:{id}}`), as a
 *  string, or null on an error/empty/malformed body. */
export function extractActivityId(resp: Record<string, unknown>): string | null {
  const result = resp?.result
  if (!result || typeof result !== 'object') return null
  const id = (result as Record<string, unknown>).id
  return id !== undefined && id !== null && `${id}` !== '' ? `${id}` : null
}

/**
 * Create the activity for `item` attached to CRM company `companyId` and return
 * its new id (to remember for dedup), or null if the API returned no id. The
 * caller guarantees a non-empty `companyId` (a todo needs an owner). A transport
 * error from `call` propagates (BullMQ then retries the job).
 */
export async function writeActivityViaRest(item: StatementItem, companyId: string, call: RestCall): Promise<string | null> {
  const params = buildTodoActivity(item, { id: Number(companyId) })
  const resp = await call(ACTIVITY_ADD_METHOD, params as unknown as Record<string, unknown>)
  return extractActivityId(resp)
}
