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

/** Pull the created message id out of the REST response (`{result:ID}`) as a
 *  string, or null on an error/empty/malformed body. `im.message.add` returns a
 *  positive integer message id on success, so we accept only that — a falsy scalar
 *  (`0`/`false`/`''`) or an object/array is treated as "no id". */
export function extractMessageId(resp: Record<string, unknown>): string | null {
  const id = resp?.result
  const n = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : NaN
  return Number.isInteger(n) && n > 0 ? `${n}` : null
}

/**
 * Announce `item` to the chat `dialogId` (e.g. `chat2941`) and return the new
 * message id, or null if the API returned none. The caller guarantees a non-empty
 * `dialogId` and that the operation passed `shouldNotifyChat`. A transport error
 * from `call` propagates (BullMQ then retries the job).
 */
export async function notifyChatViaRest(item: StatementItem, dialogId: string, call: RestCall): Promise<string | null> {
  // URL_PREVIEW=N: the message carries external (payer-controlled) text — don't let
  // a pasted URL expand into a rich preview card in the operator chat.
  const resp = await call(CHAT_MESSAGE_METHOD, {
    DIALOG_ID: dialogId,
    MESSAGE: buildChatMessage(item),
    URL_PREVIEW: 'N'
  })
  return extractMessageId(resp)
}
