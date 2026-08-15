// Post an UNMATCHED-client notice for one operation to the portal's error chat (im.message.add)
// over a portal-bound RestCall (#91, PROCESSING.md §2 C.2 / §5): the payer company wasn't found
// by its settlement account. Pure over the injected `call` — unit-testable with a fake. The
// message text is built by the shared, tested builder in app/utils/unmatchedNotice.ts; this module
// only hands the text to `postChatMessage`, which picks the route (bot first, token owner as
// fallback — #496).

import type { StatementItem } from '../../app/types/statement'
import { buildUnmatchedMessage } from '../../app/utils/unmatchedNotice'
import { postChatMessage } from './chatNotifyWrite'
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
  call: RestCall,
  memberId?: string
): Promise<string | null> {
  return postChatMessage(dialogId, buildUnmatchedMessage(item, recordedToMyCompany), call, memberId)
}
