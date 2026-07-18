// Post an UNMATCHED-client notice for one operation to the portal's error chat (im.message.add)
// over a portal-bound RestCall (#91, PROCESSING.md §2 C.2 / §5): the payer company wasn't found
// by its settlement account. Pure over the injected `call` — unit-testable with a fake. The
// message text is built by the shared, tested builder in app/utils/unmatchedNotice.ts; this module
// only does the REST call + result extraction, reusing chatNotifyWrite's method + id extractor.

import type { StatementItem } from '../../app/types/statement'
import { buildUnmatchedMessage } from '../../app/utils/unmatchedNotice'
import { CHAT_MESSAGE_METHOD, extractMessageId } from './chatNotifyWrite'
import type { RestCall } from './companyLookup'

/**
 * Send the unmatched-client notice about `item` to the error chat `dialogId` and return the new
 * message id, or null when the API returned none. `recordedToMyCompany` picks the §5 sub-case
 * wording (recorded on my company vs not recorded at all). The caller guarantees a non-empty
 * `dialogId`. A transport error from `call` propagates (the worker swallows+logs it — a chat
 * failure must never fail the job).
 */
export async function notifyUnmatchedViaRest(
  item: StatementItem,
  dialogId: string,
  recordedToMyCompany: boolean,
  call: RestCall
): Promise<string | null> {
  // URL_PREVIEW=N: the notice carries external (payer-controlled) text (the counterparty account)
  // — don't let a pasted URL expand into a rich preview card in the operator chat.
  const resp = await call(CHAT_MESSAGE_METHOD, {
    DIALOG_ID: dialogId,
    MESSAGE: buildUnmatchedMessage(item, recordedToMyCompany),
    URL_PREVIEW: 'N'
  })
  return extractMessageId(resp)
}
