// Send a chat message AS THE APP, falling back to «as the token owner» when the portal cannot host
// a bot (#496).
//
// WHY THE FALLBACK IS NOT OPTIONAL. Two documented refusals decide whether this works on a given
// portal, and neither is our bug: `ACCESS_DENIED` (the REST API is a paid-plan feature) and
// `BOT_LIMIT_EXCEEDED`. The error chat is the ONLY channel that reaches the accountant — going
// silent there would trade a cosmetic problem (message signed by a colleague) for the actual
// failure this whole product exists to prevent (nobody learns the payment did not land). So on any
// bot failure we post the same text the old way.
//
// ⚠ SCOPE IS A RE-CONSENT. `imbot` was added to B24_REQUIRED_SCOPES, and a portal installed before
// that keeps its old grant until someone reinstalls the app. Such portals will fail registration
// forever — which is exactly the case the fallback covers, and the reason it must be permanent
// rather than a launch-week crutch.

import { buildBotRegisterCall, extractBotId, isPermanentBotError } from '../../app/utils/b24BotRegister'
import { B24_CHAT_BOT } from '../../app/config/b24'
import type { RestCall } from './companyLookup'

/** REST method that posts a message as a bot. ⚠ `imbot.message.add` is the DEPRECATED generation. */
export const BOT_MESSAGE_METHOD = 'imbot.v2.Chat.Message.send'

/**
 * Per-portal bot id, resolved once per process. `null` means «this portal will not have a bot» —
 * cached just as deliberately as a positive answer, because the alternative is re-attempting a
 * registration the portal has already refused on every single message, forever.
 *
 * In memory, not in the database: a portal that changes plan gets its bot on the next restart, and
 * that is a fair price for keeping a schema out of a purely operational cache.
 */
const botIdByPortal = new Map<string, string | null>()

/** Exposed for tests — a module-level cache would otherwise leak between cases. */
export function resetBotCache(): void {
  botIdByPortal.clear()
}

/**
 * Resolve this portal's bot id, registering it if needed.
 *
 * Registration is idempotent by `code`, so calling it here is not a duplicate of the one on
 * `/install`: that one makes the bot exist promptly, this one covers portals installed BEFORE the
 * bot existed, and portals whose install-time registration failed transiently.
 *
 * ⚠ A transient failure is NOT cached. Only a documented permanent refusal demotes the portal;
 * a network blip must leave it eligible, or one bad minute would sign every message with an
 * employee's name until the next restart.
 */
export async function resolveBotId(memberId: string, call: RestCall): Promise<string | null> {
  const cached = botIdByPortal.get(memberId)
  if (cached !== undefined) return cached

  const registration = buildBotRegisterCall(B24_CHAT_BOT)
  if (!registration) return null // unreachable with the shipped constant; fail-safe anyway

  try {
    const resp = await call(registration.method, registration.params)
    const id = extractBotId(resp)
    botIdByPortal.set(memberId, id)
    return id
  } catch (error) {
    if (isPermanentBotError(error)) {
      // «Не бывает» — запоминаем, чтобы не спрашивать на каждом сообщении.
      botIdByPortal.set(memberId, null)
      return null
    }
    // Транзиентная ошибка: не кэшируем, следующая попытка спросит заново.
    return null
  }
}

/**
 * Post `text` to `dialogId` as the bot; returns the message id, or `null` when the bot route was
 * unavailable and the caller should fall back.
 *
 * ⚠ `URL_PREVIEW: 'N'` for the same reason as the non-bot path: the text carries payer-controlled
 * content, and a pasted URL must not expand into a rich card in the operator's chat.
 */
export async function sendAsBot(
  botId: string,
  dialogId: string,
  text: string,
  call: RestCall,
  extractId: (resp: Record<string, unknown>) => string | null
): Promise<string | null> {
  const resp = await call(BOT_MESSAGE_METHOD, {
    BOT_ID: Number(botId),
    DIALOG_ID: dialogId,
    MESSAGE: text,
    URL_PREVIEW: 'N'
  })
  return extractId(resp)
}
