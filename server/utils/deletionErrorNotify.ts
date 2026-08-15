// Post a DELETION-error notice to the portal's error chat over a portal-bound RestCall
// (#109, PROCESSING.md §9.2/§5). Pure over the injected `call` — unit-testable with a fake. The
// message text is built by the shared, tested builder in app/utils/deletionErrorMessage.ts; this
// module only hands it to `postChatMessage`, which picks the route (bot first, token owner as
// fallback — #496). The caller guarantees a non-empty `dialogId` (skips when the portal has no
// error chat).

import { buildDeletionErrorMessage, type DeletionErrorKind } from '../../app/utils/deletionErrorMessage'
import { postChatMessage } from './chatNotifyWrite'
import type { RestCall } from './companyLookup'

/**
 * Send the deletion-error notice for `kind`/`id` to the error chat `dialogId` and return the new
 * message id, or null when the builder had nothing to send / the API returned no id. `opts.freed`
 * is the count of freed distribution rows (target deletions). A transport error from `call`
 * propagates (the worker swallows+logs it — a chat failure must never fail the job).
 */
export async function notifyDeletionErrorViaRest(
  kind: DeletionErrorKind,
  id: string,
  dialogId: string,
  call: RestCall,
  opts: { freed?: number } = {},
  memberId?: string
): Promise<string | null> {
  const message = buildDeletionErrorMessage(kind, id, opts)
  if (!message) return null
  return postChatMessage(dialogId, message, call, memberId)
}
