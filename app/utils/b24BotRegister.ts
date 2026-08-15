/**
 * Pure builder for the `imbot.v2.Bot.register` call (#496) — so chat messages arrive from the APP,
 * not from whichever employee's OAuth token the worker happens to hold.
 *
 * WHY IT MATTERS MOST FOR THE ERROR CHAT. `im.message.add` posts as the token OWNER; there is no
 * other mode. So «Клиент не определён, заведите реквизит» reaches the accountant looking like a
 * message from a colleague — and it is that colleague who then gets asked about it.
 *
 * ⚠ TWO GENERATIONS OF THIS API. `imbot.register` / `imbot.message.add` are DEPRECATED; the live
 * pair is `imbot.v2.Bot.register` + `imbot.v2.Chat.Message.send`, scope `imbot`. Do not «simplify»
 * back to the short names.
 *
 * ⚠ `botToken` is for WEBHOOK-registered bots only and must never be sent under OAuth. `eventMode`
 * defaults to `fetch`, which is right for a bot that only ever sends — we expose no webhook URL for
 * the portal to call back into.
 *
 * Registration is IDEMPOTENT BY `code`: re-registering returns the existing bot and overwrites
 * nothing, so the install flow may call it on every (re)install with no dedup of our own.
 *
 * No SDK import — unit-testable; the transport is the caller's, like `b24TriggerRegister.ts`.
 */

import type { B24Call } from './b24EventBind'

/** Bot properties the portal shows next to each message. */
export interface BotRegistration {
  /** Idempotency key ON THE CLIENT'S PORTAL — see the warning on `B24_CHAT_BOT`. */
  code: string
  name: string
  /** Shown under the name, where a person's job title would be. */
  position: string
}

/**
 * Build the registration call, or `null` when the inputs are unusable — fail-safe, so the install
 * flow never sends a malformed registration.
 *
 * `TYPE: 'B'` is a plain bot (not a supervisor/human-handover type): it posts and nothing more,
 * which is the whole of what we need and the least the portal has to trust.
 */
export function buildBotRegisterCall(bot: BotRegistration): B24Call | null {
  const code = (bot?.code ?? '').trim()
  const name = (bot?.name ?? '').trim()
  const position = (bot?.position ?? '').trim()
  if (!code || !name) return null
  return {
    method: 'imbot.v2.Bot.register',
    params: {
      CODE: code,
      TYPE: 'B',
      // `eventMode` is deliberately omitted: its default (`fetch`) is what a send-only bot wants,
      // and naming it would imply we handle callbacks we do not register a URL for.
      PROPERTIES: { NAME: name, WORK_POSITION: position }
    }
  }
}

/**
 * Pull the bot id out of a register response. The portal answers `{result: <id>}`; a re-register of
 * an existing `code` answers with that same id, which is exactly the idempotency we rely on.
 *
 * Only a positive integer counts. Getting this wrong is silent in the worst direction — a bogus id
 * would be sent as `BOT_ID` on every message, the portal would reject each one, and the fallback
 * would never engage because we'd believe we had a bot.
 */
export function extractBotId(resp: Record<string, unknown>): string | null {
  const raw = resp?.result
  const value = raw !== null && typeof raw === 'object'
    ? (raw as Record<string, unknown>).id ?? (raw as Record<string, unknown>).ID
    : raw
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(n) && n > 0 ? `${n}` : null
}

/**
 * Errors that mean «this portal will never have a bot», as opposed to «try again later».
 *
 * The distinction is the whole point of the fallback: these are properties of the client's portal,
 * not transient faults. Retrying them on every message would burn REST budget forever and still
 * deliver nothing — so we stop asking and post as the token owner instead. A network blip is NOT in
 * this list: it must stay retryable, or one bad minute would demote a healthy portal until restart.
 *
 * ⚠ THE MISSING-SCOPE SHAPE IS THE ONE THAT MATTERS MOST, and it does not say «ACCESS_DENIED».
 * Every portal installed before this feature keeps its old grant without `imbot` until it
 * reinstalls — that is the COMMON case, not the exotic one. This repo already learned what that
 * failure looks like on the wire (#408, `classifyProvisionError`): the machine-readable
 * `insufficient_scope` is often absent and all the SDK surfaces is the human sentence «The request
 * requires HIGHER PRIVILEGES than provided by the … token». Omitting those two would classify the
 * entire existing install base as «transient» and re-attempt registration on every single chat
 * message, forever, against a rate limit this codebase otherwise guards carefully.
 */
const PERMANENT_BOT_ERRORS = [
  'access_denied',
  'access denied',
  'bot_limit_exceeded',
  'error_method_not_found',
  'invalid_credentials',
  // Missing `imbot` scope — see the warning above.
  'insufficient_scope',
  'higher privileges'
]

/** Whether an error from the bot API means «give up on the bot for this portal». */
export function isPermanentBotError(error: unknown): boolean {
  const text = `${(error as Error)?.message ?? error ?? ''}`.toLowerCase()
  return PERMANENT_BOT_ERRORS.some(code => text.includes(code))
}
