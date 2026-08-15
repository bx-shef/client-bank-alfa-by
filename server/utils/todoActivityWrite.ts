// Transport for the universal timeline activity (#495): create it, then stamp our dedup marker.
//
// Two calls, and that is forced, not chosen: `crm.activity.todo.add` accepts no external-source
// marker, and `DESCRIPTION_TYPE` (BB vs HTML) has no parameter there either — both live only on
// `crm.activity.update`. The builder explains why the carrier changed anyway; this module's job is
// to make the two-call sequence behave as much like one call as the API allows.
//
// THE WINDOW, AND WHAT WE DO ABOUT IT. Between `add` and `update` an activity exists with NO
// marker. If we stopped there, a retry would not find it and would write a SECOND activity, while
// the first stayed invisible to dedup forever — a duplicate in a client's timeline that nothing
// ever cleans up. So a failed update is COMPENSATED: we delete the activity we just created and
// let the error propagate, so BullMQ retries from a clean state.
//
// ⚠ What remains: a hard crash (process killed, container evicted) between `add` and the
// compensating `delete`. That leaves one orphan and one eventual duplicate. It cannot be closed
// from this side — only an atomic create-with-marker could, and the API does not offer one for
// this activity type. It is the accepted cost of a card that works, and it is bounded: one
// duplicate per crash, not per operation.

import type { StatementItem } from '../../app/types/statement'
import {
  ACTIVITY_DELETE_METHOD, ACTIVITY_UPDATE_METHOD, TODO_ACTIVITY_ADD_METHOD,
  buildActivityMarkerUpdate, buildTodoActivity
} from '../../app/utils/todoActivity'
import type { RestCall } from './companyLookup'

/**
 * Pull the created activity id out of the `todo.add` response.
 *
 * ⚠ The shape differs from the configurable path: `todo.add` answers `{result:{id}}` (and some
 * portals `{result: id}`), while `configurable.add` nested it as `{result:{activity:{id}}}`.
 * Both spellings are accepted here because getting this wrong is silent — a null id reads as
 * «nothing was written», the marker never gets stamped, and every poll re-creates the activity.
 */
export function extractTodoActivityId(resp: Record<string, unknown>): string | null {
  const result = resp?.result
  if (result === undefined || result === null) return null
  const raw = typeof result === 'object' ? (result as Record<string, unknown>).id : result
  if (raw === undefined || raw === null || `${raw}` === '') return null
  const id = `${raw}`
  // A non-numeric id means we misread the envelope; treating it as valid would stamp the marker
  // onto nothing and hide the problem behind a successful-looking job.
  return /^\d+$/.test(id) ? id : null
}

/**
 * Create the activity for `item` on CRM company `companyId`, stamp the dedup marker, and return
 * the new id (or null when the API returned none). `note` prepends a reason block (the
 * unmatched-client fallback, #91). Transport errors propagate — BullMQ retries the job.
 */
export async function writeTodoActivityViaRest(
  item: StatementItem,
  companyId: string,
  call: RestCall,
  note?: string
): Promise<string | null> {
  const params = buildTodoActivity(item, { id: Number(companyId) }, note)
  const added = await call(TODO_ACTIVITY_ADD_METHOD, params as unknown as Record<string, unknown>)
  const id = extractTodoActivityId(added)
  // No id ⇒ nothing to mark and nothing to clean up. Returning null keeps the caller's existing
  // contract («not written»), which counts the op unmatched and retries it on the next poll.
  if (!id) return null

  try {
    await call(ACTIVITY_UPDATE_METHOD, { id: Number(id), fields: buildActivityMarkerUpdate(item) })
  } catch (updateError) {
    // Compensate: an unmarked activity is worse than none — it is a permanent duplicate-in-waiting.
    // The delete is best-effort; if IT fails too we still surface the ORIGINAL error, because that
    // is the one that explains what happened.
    try {
      await call(ACTIVITY_DELETE_METHOD, { id: Number(id) })
    } catch (deleteError) {
      console.error(
        `[activity] marker update failed AND the orphan could not be deleted (activity ${id}) — a duplicate will appear on the next run: ${(deleteError as Error)?.message}`
      )
    }
    throw updateError
  }
  return id
}
