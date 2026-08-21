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
  ACTIVITY_DELETE_METHOD, ACTIVITY_ORIGINATOR_ID, ACTIVITY_UPDATE_METHOD, TODO_ACTIVITY_ADD_METHOD,
  buildActivityMarkerUpdate, buildTodoActivity
} from '../../app/utils/todoActivity'
import { dedupKey } from '../../app/utils/statement'
import { findActivityByMarker } from './activityMarkerLookup'
import type { RestCall } from './companyLookup'
import { useServerLogger } from './serverLogger'

const log = useServerLogger('activity')

/**
 * Portals whose marker mechanism has been proven ON THIS PROCESS. See `verifyMarkerOnce`.
 * In-memory by design: it is a probe, not a fact worth persisting, and a restart re-proving it
 * costs one REST call.
 */
const markerProven = new Set<string>()

/** How hard the proof tries before calling the marker absent — see the retry note in
 *  `verifyMarkerOnce`. Runs once per portal per process, so the budget is generous on purpose. */
export const MARKER_VERIFY_ATTEMPTS = 3
export const MARKER_VERIFY_DELAY_MS = 1000

/** Exposed for tests — a module-level cache would otherwise leak between cases. */
export function resetMarkerProof(): void {
  markerProven.clear()
}

/**
 * Prove — ONCE per portal per process — that the marker we just stamped is actually findable.
 *
 * WHY THIS EXISTS. The marker is set by a SECOND call (`crm.activity.update`), because `todo.add`
 * does not accept it. The compensating delete above covers an update that ERRORS. It does not cover
 * an update that reports success while the field does not stick — and that failure is silent,
 * total, and unbounded: `findActivityByMarker` finds nothing on the next run, so EVERY operation is
 * written again, every poll, forever, into a client's CRM. Unit tests cannot rule it out (they do
 * not know what a real portal does with these fields on this activity type), which is exactly why
 * the smoke script existed as a manual pre-deploy gate.
 *
 * So the code proves it itself, on the first real write: read the marker back the same way the next
 * run would. If it is not there, throw — the job retries, the operation is not silently duplicated,
 * and the message says what to check. One extra REST call per portal per process is a rounding
 * error next to a timeline nobody can clean up.
 *
 * ⚠ Failure to VERIFY (transport error) is not failure to mark: it is rethrown by `call` and
 * handled as any other transient error. Only a definite «not found» is treated as proof of absence.
 */
async function verifyMarkerOnce(
  item: StatementItem,
  memberId: string,
  call: RestCall,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<void> {
  if (markerProven.has(memberId)) return
  const key = dedupKey(item)
  // ⚠ RETRIED, because «not found immediately» and «not settable» are different facts and only the
  // second one deserves a thrown job. We are reading back a field written a moment ago through a
  // different method; if the portal needs a beat to make it searchable, a single-shot check would
  // fail the FIRST job of every healthy portal — turning a safety net into an outage. Three tries
  // over a couple of seconds cost nothing (this runs once per portal per process) and leave only
  // the genuine case: the update reported success and the field is simply not there.
  for (let attempt = 1; attempt <= MARKER_VERIFY_ATTEMPTS; attempt += 1) {
    if (await findActivityByMarker(ACTIVITY_ORIGINATOR_ID, key, call)) {
      markerProven.add(memberId)
      return
    }
    if (attempt < MARKER_VERIFY_ATTEMPTS) await sleep(MARKER_VERIFY_DELAY_MS)
  }
  throw new Error(
    '[activity] the dedup marker did not stick: the activity was created and updated without error, '
    + 'but a search by ORIGINATOR_ID/ORIGIN_ID does not find it. Every operation would be written '
    + 'again on every run. Check that crm.activity.update may set these fields on this portal '
    + '(pnpm activity:test --company <id> --apply).'
  )
}

/**
 * Remove an activity we created but could not make findable. Best-effort: if the delete ITSELF
 * fails we log and let the caller surface the ORIGINAL error, because that is the one that explains
 * what happened — and the surviving orphan is exactly what the log line warns about.
 */
async function deleteOrphan(id: string, call: RestCall): Promise<void> {
  try {
    await call(ACTIVITY_DELETE_METHOD, { id: Number(id) })
  } catch (deleteError) {
    log.error(`could not delete the unmarked activity ${id} — a duplicate will appear on the next run: ${(deleteError as Error)?.message}`)
  }
}

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
  note?: string,
  /** Portal id — used only to prove the marker mechanism once per process (`verifyMarkerOnce`).
   *  Omitted ⇒ no verification (keeps the smoke script and older callers working unchanged). */
  memberId?: string,
  /** Injected only by tests, so the retry loop does not spend real seconds. */
  sleep?: (ms: number) => Promise<void>
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
    await deleteOrphan(id, call)
    throw updateError
  }

  // Проверяется ПОСЛЕ успешной маркировки и только один раз на портал: см. `verifyMarkerOnce`.
  //
  // ⚠ Провал проверки КОМПЕНСИРУЕТСЯ так же, как провал маркировки, и по той же причине. Без этого
  // на сломанном портале каждая попытка BullMQ оставляла бы по одному ненаходимому делу: джоба
  // падает, ретрай не находит маркер, пишет заново, снова падает. Ограниченно (числом попыток, а не
  // числом операций) — но ноль лучше, чем «немного». А если маркер на самом деле стоял и мы просто
  // не смогли его прочитать, удаление тоже безвредно: повторный прогон создаст дело заново.
  if (memberId) {
    try {
      await verifyMarkerOnce(item, memberId, call, sleep)
    } catch (verifyError) {
      await deleteOrphan(id, call)
      throw verifyError
    }
  }
  return id
}
