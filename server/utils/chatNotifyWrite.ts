// Post a chat announcement for one operation (im.message.add) over a portal-bound
// RestCall. Pure over the injected `call` — unit-testable with a fake. The message
// text is built by the shared, tested builder in app/utils/chatMessage.ts; this
// module only does the REST call + result extraction. Whether an operation is
// announced (direction / exclusions) is decided upstream by `shouldNotifyChat`.

import type { StatementItem } from '../../app/types/statement'
import { buildChatMessage } from '../../app/utils/chatMessage'
import type { RestCall } from './companyLookup'

/** REST method that posts a message to a Bitrix24 chat. */
export const CHAT_MESSAGE_METHOD = 'im.message.add'

/** Pull the created message id (a number) out of the REST response (`{result:ID}`),
 *  as a string, or null on an error/empty/malformed body. */
export function extractMessageId(resp: Record<string, unknown>): string | null {
  const id = resp?.result
  return id !== undefined && id !== null && `${id}` !== '' && typeof id !== 'object' ? `${id}` : null
}

/**
 * Announce `item` to the chat `dialogId` (e.g. `chat2941`) and return the new
 * message id, or null if the API returned none. The caller guarantees a non-empty
 * `dialogId` and that the operation passed `shouldNotifyChat`. A transport error
 * from `call` propagates (BullMQ then retries the job).
 */
export async function notifyChatViaRest(item: StatementItem, dialogId: string, call: RestCall): Promise<string | null> {
  const resp = await call(CHAT_MESSAGE_METHOD, { DIALOG_ID: dialogId, MESSAGE: buildChatMessage(item) })
  return extractMessageId(resp)
}
