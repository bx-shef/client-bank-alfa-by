// Post an ALLOCATION-error notice for one operation to the portal's error chat
// (im.message.add) over a portal-bound RestCall (#109, PROCESSING.md §5). Pure over
// the injected `call` — unit-testable with a fake. The message text is built by the
// shared, tested builder in app/utils/allocationErrorMessage.ts; this module only
// does the REST call + result extraction, reusing chatNotifyWrite's method name +
// id extractor. Whether a decision warrants a notice is decided by the builder (it
// returns null for a clean allocate / none — then nothing is sent).

import type { StatementItem } from '../../app/types/statement'
import type { AllocationDecision } from '../../app/utils/allocation'
import { buildAllocationErrorMessage } from '../../app/utils/allocationErrorMessage'
import { CHAT_MESSAGE_METHOD, extractMessageId } from './chatNotifyWrite'
import type { RestCall } from './companyLookup'

/**
 * Send the error notice for `decision` about `item` to the error chat `dialogId`
 * and return the new message id, or null when there was nothing to send (the
 * builder returned null) or the API returned no id. The caller guarantees a
 * non-empty `dialogId`. A transport error from `call` propagates to the caller
 * (the worker swallows+logs it — a chat failure must never fail the job).
 */
export async function notifyAllocationErrorViaRest(
  item: StatementItem,
  decision: AllocationDecision,
  dialogId: string,
  call: RestCall
): Promise<string | null> {
  const message = buildAllocationErrorMessage(item, decision)
  if (!message) return null
  // URL_PREVIEW=N: the headline carries external (payer-controlled) text — don't let
  // a pasted URL expand into a rich preview card in the operator chat.
  const resp = await call(CHAT_MESSAGE_METHOD, {
    DIALOG_ID: dialogId,
    MESSAGE: message,
    URL_PREVIEW: 'N'
  })
  return extractMessageId(resp)
}
