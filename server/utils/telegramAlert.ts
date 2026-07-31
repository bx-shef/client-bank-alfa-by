// Outbound alert channel — Telegram (#426, ported from `ai-price-import`).
//
// Until now a queue problem only went to the server log and the `/queues` page: both require
// somebody to already be looking, which is exactly what an alert is for. Telegram is the first
// channel that pushes.
//
// This is OUR infrastructure talking to US. It is deliberately NOT the per-portal error chat
// (`errorChat` in the portal settings): a stalled queue is our outage, not the tenant's, and telling
// a client's accountant about our Redis would be both useless to them and a leak of how the service
// is run. The two channels never overlap — the error chat carries «этот платёж требует человека»,
// this one carries «сервис сломан».
//
// PRIVACY: the message text is built from queue names and counters only. No amounts, accounts,
// purposes or counterparties ever reach it — the same allowlist principle as the telemetry spans
// (`telemetryAttributes.ts`, `docs/PRIVACY.md`).
//
// SECURITY: the bot token is a bearer credential that sits in the URL of every call. It is never
// logged, never put in an error message, and never returned to a caller — only the numeric status
// is surfaced. Same rule as the GitHub feedback token.

/** Minimal fetch shape this module needs — injectable so tests need no network. Mirrors
 *  `FeedbackFetchFn` (feedbackGithub.ts); we never read the body, only the status. */
export type AlertFetchFn = (
  url: string,
  init: { method: string, headers: Record<string, string>, body: string, signal?: AbortSignal }
) => Promise<{ status: number }>

export interface TelegramConfig {
  token: string
  /** Group/channel id. Groups are negative («-100…»), a private chat is a positive user id. */
  chatId: string
}

/** Bot tokens look like `<digits>:<base64ish>` — a shape check catches a truncated paste. */
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/
/** A chat id is an integer, optionally negative; `@channelname` is also accepted by Telegram. */
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/

/**
 * Resolve the channel from env, or `null` when it is off.
 *
 * Fail-closed and silent about why beyond a shape verdict: an unset channel is a normal deployment
 * (dev, an SSG-only build), not an error — the same model as the feedback channel
 * (`feedbackConfig.ts`). Both parts are required — a token with no chat id has nowhere to send, and
 * half-configured would otherwise look enabled and drop every alert. `envCheck` says so loudly at
 * boot; here we just decide.
 */
export function resolveTelegramConfig(env: Record<string, string | undefined> = process.env): TelegramConfig | null {
  const token = (env.TELEGRAM_ALERT_BOT_TOKEN ?? '').trim()
  const chatId = (env.TELEGRAM_ALERT_CHAT_ID ?? '').trim()
  if (!TOKEN_RE.test(token) || !CHAT_RE.test(chatId)) return null
  return { token, chatId }
}

/** True when the operator clearly MEANT to configure the channel — used by `envCheck` to tell a
 *  typo apart from «канал просто выключен». Either variable present counts as intent. */
export function telegramConfigAttempted(env: Record<string, string | undefined> = process.env): boolean {
  return !!((env.TELEGRAM_ALERT_BOT_TOKEN ?? '').trim() || (env.TELEGRAM_ALERT_CHAT_ID ?? '').trim())
}

export interface TelegramSendResult {
  ok: boolean
  status: number
  /** Could a later attempt plausibly succeed? 429/5xx/network yes; 400/401/403 no. */
  retryable: boolean
}

/** Telegram caps a message at 4096 characters. */
export const MAX_TELEGRAM_TEXT = 4096

/**
 * Hard bound on one send.
 *
 * Without it the call inherits undici's 300-second header timeout, and the caller — which sends
 * sequentially — could sit for tens of minutes. Worse, an outgoing HTTP call hanging is CORRELATED
 * with the outage being reported (a host network problem breaks both), so exactly when the alert
 * matters most the channel would be at its slowest. Ten seconds is far more than a healthy
 * `sendMessage` needs.
 */
export const TELEGRAM_TIMEOUT_MS = 10_000

/**
 * Send one message.
 *
 * `parse_mode` is deliberately NOT set: plain text means there is no markup for anything in the
 * message to escape out of. Our alert text is built from queue names and numbers today, but the
 * cost of that guarantee is zero and it survives someone later interpolating a portal-supplied
 * string in here.
 */
export async function sendTelegramAlert(config: TelegramConfig, text: string, fetchFn: AlertFetchFn): Promise<TelegramSendResult> {
  const body = JSON.stringify({
    chat_id: config.chatId,
    text: text.slice(0, MAX_TELEGRAM_TEXT),
    disable_web_page_preview: true
  })
  let res: Awaited<ReturnType<AlertFetchFn>>
  try {
    res = await fetchFn(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    })
  } catch {
    // Never include the error: it can echo the request URL, and the URL carries the token.
    return { ok: false, status: 0, retryable: true }
  }
  const status = res.status
  return { ok: status === 200, status, retryable: status === 429 || status >= 500 }
}
