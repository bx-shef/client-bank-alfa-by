// Bank OAuth callback (stage 5, A7b-2) — pure logic over injected I/O (DI). The bank redirects the
// admin's TOP-LEVEL browser to `/api/bank/callback?code=…&state=…` after consent. We verify the
// SIGNED state (bankConnectState — this is the only auth here; there is no frame token on a bank
// redirect), then exchange the `code` for tokens and persist them under the portal+provider+account
// the state carries. Returns a minimal HTML page for the admin to close the tab.
//
// SECURITY invariants (from the A7a/A7b-1 reviews):
//  - Verify the state (HMAC + exp + shape) BEFORE any REST; trust memberId/provider/accountKey ONLY
//    from the verified state, never from the query.
//  - `error`/`error_description` in the callback and the token error are PROVIDER-controlled → never
//    render them to the page and only log a SANITIZED form (strip CRLF, cap length) so they can't
//    forge log lines or leak into the page.
//  - The token-exchange body carries `client_secret` — never logged (we log neither the body nor the
//    raw error object).

import { parseOAuthCallback, buildTokenExchangeBody, parseTokenResponse, type AlfaOAuthConfig } from '../../app/utils/alfaOauth'
import { verifyConnectState } from './bankConnectState'
import type { BankToken } from './bankTokenStore'
import type { BankProviderId } from '../../app/types/statement'

export interface CallbackResult {
  status: number
  /** Minimal HTML body for the top-level tab. */
  html: string
}

export interface CallbackDeps {
  /** HMAC secret for the connect state (operator SESSION_SECRET). Empty ⇒ every state fails. */
  secret: string
  /** Per-provider authorize/token config from env (null ⇒ not configured). */
  config: (provider: BankProviderId) => AlfaOAuthConfig | null
  /** The provider's OAuth client secret (server-only). Empty ⇒ can't exchange. */
  clientSecret: (provider: BankProviderId) => string
  /** POST the token-exchange body to `${baseUrl}/token`, returning the raw JSON. MUST NOT log the
   *  body (client_secret) or leak it on error. */
  exchangeToken: (baseUrl: string, body: URLSearchParams) => Promise<unknown>
  /** Persist the connected account's tokens (encrypts refresh). */
  saveToken: (token: BankToken) => Promise<void>
  /** Optional sanitized logger (already-safe strings only). */
  log?: (msg: string) => void
}

export interface CallbackInput {
  query: Record<string, string | string[] | undefined>
  nowMs: number
}

/** Strip CR/LF and cap length — provider-controlled text is logged only through this. */
export function sanitizeForLog(s: string, max = 200): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, max)
}

const page = (title: string, msg: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">`
  + `<h1 style="font-size:1.25rem">${title}</h1><p>${msg}</p><p style="color:#666">Можно закрыть эту вкладку.</p>`

const OK_PAGE = page('Счёт подключён', 'Банковский счёт подключён к порталу. Импорт выписки начнётся автоматически.')
const ERR_PAGE = page('Не удалось подключить', 'Ссылка недействительна или срок её действия истёк. Повторите подключение из настроек приложения.')
const EXCHANGE_ERR_PAGE = page('Не удалось подключить', 'Банк отклонил подключение. Повторите попытку из настроек приложения.')

/**
 * Complete the bank OAuth connect: verify the signed state, exchange the code, persist the token.
 * Returns an HTML page (200 success / 400 bad-or-expired state / 502 exchange failure). Never
 * renders provider-controlled text; logs provider errors only through `sanitizeForLog`.
 */
export async function handleBankConnectCallback(deps: CallbackDeps, input: CallbackInput): Promise<CallbackResult> {
  const raw = input.query.state
  const rawState = Array.isArray(raw) ? raw[0] : raw

  // 1) Verify the signed state FIRST — the only auth on a bank redirect. Bad/expired ⇒ stop.
  const state = verifyConnectState(rawState, deps.secret, input.nowMs)
  if (!state || !state.accountKey) {
    return { status: 400, html: ERR_PAGE }
  }

  // 2) Extract the code / surface a provider error — WITHOUT rendering or raw-logging its text.
  let code: string
  try {
    code = parseOAuthCallback(input.query, rawState as string).code
  } catch (e) {
    deps.log?.(`[bank-connect] callback rejected: ${sanitizeForLog((e as Error)?.message ?? 'error')}`)
    return { status: 400, html: ERR_PAGE }
  }

  const config = deps.config(state.provider)
  const clientSecret = deps.clientSecret(state.provider)
  if (!config || !clientSecret) {
    deps.log?.(`[bank-connect] callback: provider ${state.provider} not configured for exchange`)
    return { status: 400, html: ERR_PAGE }
  }

  // 3) Exchange code → tokens. Body carries client_secret — never logged.
  let tokens
  try {
    const rawTokens = await deps.exchangeToken(config.baseUrl, buildTokenExchangeBody(config, code, clientSecret))
    tokens = parseTokenResponse(rawTokens as Record<string, unknown>)
  } catch (e) {
    deps.log?.(`[bank-connect] token exchange failed: ${sanitizeForLog((e as Error)?.message ?? 'error')}`)
    return { status: 502, html: EXCHANGE_ERR_PAGE }
  }

  // 4) Persist under the portal+provider+account the VERIFIED state carries.
  await deps.saveToken({
    memberId: state.memberId,
    provider: state.provider,
    accountKey: state.accountKey,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: input.nowMs + tokens.expiresIn * 1000
  })
  deps.log?.(`[bank-connect] connected ${state.provider} account for member ${state.memberId}`)
  return { status: 200, html: OK_PAGE }
}
