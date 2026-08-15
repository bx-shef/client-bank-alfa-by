// The single place a chat message leaves this app.
//
// Message TEXT is built by the shared, tested builders (`chatMessage.ts`, `allocationErrorMessage.ts`
// …); whether an operation is announced at all is decided upstream (`shouldNotifyChat`). This module
// only performs the REST call and extracts the id.
//
// ⚠ ONE CHOKE POINT ON PURPOSE (#496). There are five kinds of chat message (import announcement,
// allocation error, unresolved target, unmatched client, deletion notice) and every one of them
// used to do its own `im.message.add`. Sending as the BOT instead has to hold for all five —
// otherwise the same portal would show some messages from the app and some from a colleague, which
// is more confusing than the original problem. So the choice of route lives here, once, and the
// five callers just hand over `dialogId` + text.

import type { StatementItem } from '../../app/types/statement'
import { buildChatMessage } from '../../app/utils/chatMessage'
import { resolveBotId, sendAsBot } from './chatBotSend'
import type { RestCall } from './companyLookup'

/** REST method that posts a message as the TOKEN OWNER. The fallback route — see `postChatMessage`. */
export const CHAT_MESSAGE_METHOD = 'im.message.add'

/** Pull the created message id out of an `im.message.add` response (`{result:ID}`) as a
 *  string, or null on an error/empty/malformed body. `im.message.add` returns a positive
 *  integer message id on success, so we accept only that — a falsy scalar
 *  (`0`/`false`/`''`) or an object/array is treated as "no id".
 *
 *  ⚠ STRICT ON PURPOSE, and NOT shared with the bot route: this method answers a scalar, so an
 *  object here means we misread the envelope, and quietly digging an `id` out of it would hide
 *  that. The bot's own shape is `extractBotMessageId` below. */
export function extractMessageId(resp: Record<string, unknown>): string | null {
  const id = resp?.result
  const n = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : NaN
  return Number.isInteger(n) && n > 0 ? `${n}` : null
}

/**
 * Post `text` to `dialogId`, preferring the app's own bot (#496).
 *
 * `memberId` is what makes the bot route possible (the bot is registered per portal and cached);
 * omit it and this is exactly the old behaviour. A bot failure of ANY kind falls back to
 * `im.message.add` rather than propagating: the error chat is the only channel that reaches the
 * accountant, and going silent there would trade a cosmetic problem (message signed by a colleague)
 * for the failure this product exists to prevent.
 *
 * A failure of the FALLBACK still propagates — that one is a real transport error, and the caller
 * (a job) should see it.
 */
export async function postChatMessage(
  dialogId: string,
  text: string,
  call: RestCall,
  memberId?: string
): Promise<string | null> {
  if (memberId) {
    const botId = await resolveBotId(memberId, call)
    if (botId) {
      try {
        // ⚠ ОТСУТСТВИЕ ИСКЛЮЧЕНИЯ И ЕСТЬ ДОСТАВКА — не наличие разобранного id.
        //
        // Транспорт проекта (`makeSdkRestCall`) БРОСАЕТ на `!isSuccess`, поэтому вернувшийся ответ
        // уже означает, что портал сообщение принял. Состояния «отправили, но не уверены» здесь
        // не существует.
        //
        // Раньше тут стоял откат по «не смогли достать id», и это была бомба: имена полей в конверте
        // `imbot.v2.*` мы УГАДЫВАЕМ (`id`/`ID`/`messageId`), живьём не подтверждали. Не угадай мы —
        // каждое сообщение уходило бы ДВАЖДЫ: один раз ботом, второй «на всякий случай». Не изредка,
        // а детерминированно, во все чаты. Дублировать сообщения бухгалтеру хуже, чем не знать их id.
        //
        // Сам id никому не нужен для правильности — все вызывающие его игнорируют; он информационный.
        return await sendAsBot(botId, dialogId, text, call)
      } catch {
        // Настоящий отказ бота — вот здесь. Шлём как раньше: молчащий чат ошибок хуже, чем
        // сообщение с чужой подписью.
      }
    }
  }
  // URL_PREVIEW=N: the message carries external (payer-controlled) text — don't let
  // a pasted URL expand into a rich preview card in the operator chat.
  const resp = await call(CHAT_MESSAGE_METHOD, { DIALOG_ID: dialogId, MESSAGE: text, URL_PREVIEW: 'N' })
  return extractMessageId(resp)
}

/**
 * Announce `item` to the chat `dialogId` (e.g. `chat2941`) and return the new
 * message id, or null if the API returned none. The caller guarantees a non-empty
 * `dialogId` and that the operation passed `shouldNotifyChat`. A transport error
 * from `call` propagates (BullMQ then retries the job).
 */
export async function notifyChatViaRest(
  item: StatementItem,
  dialogId: string,
  call: RestCall,
  memberId?: string
): Promise<string | null> {
  return postChatMessage(dialogId, buildChatMessage(item), call, memberId)
}
