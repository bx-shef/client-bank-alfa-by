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
import { buildCodeExchangeBody, parsePriorTokenResponse, priorTokenRequest } from '../../app/utils/priorOauth'
import type { PriorTokenAuth } from '../../app/utils/priorOauth'
import { verifyConnectState } from './bankConnectState'
import { provisionalAccountKey } from '../../app/utils/bankAccountKey'
import { describeUpstreamError, sanitizeForLog } from './logSanitize'
import type { PriorConnectConfig } from './priorConnectStart'
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
  /** Prior's connect config from env (null ⇒ not configured), A5b. */
  priorConfig: () => PriorConnectConfig | null
  /** POST Prior's code exchange, returning the raw JSON. Client authentication is already applied
   *  (`priorTokenRequest`, #444): under client_secret_basic `headers` carries the Authorization
   *  header; under private_key_jwt it is empty and the signed assertion rides in `body`. MUST NOT
   *  log either. */
  exchangePriorToken: (url: string, body: string, headers: Record<string, string>) => Promise<unknown>
  /** Resolve client authentication for Prior's token endpoint (signs a fresh `client_assertion`
   *  under private_key_jwt). Injected so the handler stays testable without node:crypto. */
  priorTokenAuth: (config: PriorConnectConfig) => PriorTokenAuth
  /** Persist the connected account's tokens (encrypts refresh). */
  saveToken: (token: BankToken) => Promise<void>
  /** Optional sanitized logger (already-safe strings only). */
  log?: (msg: string) => void
}

export interface CallbackInput {
  query: Record<string, string | string[] | undefined>
  nowMs: number
}

/**
 * Patience for the code→token exchange, in ms. Deliberately longer than our other outbound calls:
 * this is the only step whose failure lands on a person who has ALREADY typed their internet-bank
 * password, and the code is single-use, so a timeout here costs them another trip through that
 * login. Measured against Priorbank's sandbox (2026-08-14) the `authorization_code` grant is
 * markedly slower than `client_credentials` on the same endpoint — one live connect blew through
 * 15s and showed «банк отклонил подключение» to an account holder who had done everything right,
 * while the very next attempt succeeded.
 *
 * ⚠ THE NUMBER IS NOT FREE TO RAISE — it sits inside TWO proxy ceilings, and whichever fires first
 * wins. Nearest is our own nginx (`proxy_read_timeout` on `location = /api/bank/callback`, which
 * overrides the 30s shared default precisely because of this constant — `tests/bankRouteTimeouts.test.ts`
 * keeps the two in step). Above that is the shared edge proxy, whose default is nginx's own 60s and
 * which this repository does not configure. So the budget is: this constant < our nginx < 60s.
 * Exceed the edge and the admin gets a bare `504` from a server we don't own instead of the page
 * below — worse than the 15s we started from, because the failure stops being ours to explain.
 *
 * A raise past this point needs measurement, not another incident: the exchange is not yet wrapped
 * in `withDependencySpan`, so nobody can see the real latency distribution (follow-up issue).
 */
export const TOKEN_EXCHANGE_TIMEOUT_MS = 45_000

/** Seconds before the tab closes itself. This tab is a dead end — it exists only to carry the
 *  bank's redirect, and the admin's work continues in the portal tab behind it. Long enough to read
 *  one sentence, and ALWAYS cancellable: an auto-close that cannot be stopped takes the page away
 *  from anyone who reads slowly, and the failure pages are exactly the ones worth re-reading. */
export const AUTO_CLOSE_SEC = 5

/** Static fallback text — also what the page shows when the countdown is cancelled or JS is off. */
const CLOSE_HINT = 'Можно закрыть эту вкладку.'

// The countdown lives in `public/bank-callback.js`, NOT inline: the page is served under the site's
// CSP (`script-src 'self'`, no 'unsafe-inline'), so an inline script would need its sha256 kept in
// step with nginx.conf by hand — a guard that silently rots the first time the text changes. An
// external same-origin file needs none of that. Progressive enhancement: with no JS the page still
// reads correctly, it just doesn't close itself.
const page = (title: string, msg: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">`
  + `<h1 style="font-size:1.25rem">${title}</h1><p>${msg}</p>`
  + `<p id="close-hint" style="color:#666" data-seconds="${AUTO_CLOSE_SEC}">${CLOSE_HINT}</p>`
  + `<script src="/bank-callback.js" defer></script>`

// ⚠ TWO success pages, because there are two outcomes and only one of them means «готово».
// Connecting no longer asks for an account number up front (it never steered the bank's consent),
// so the usual landing is a bank bound to the portal with no account chosen yet — and such a
// connection is deliberately NOT polled (`isPendingAccountKey`), because the bank has no such
// «number» and the job would fail on every tick. Telling that admin «импорт начнётся автоматически»
// promises something the app will not do, and the silence afterwards looks like a broken import
// rather than an unfinished setup.
const OK_PAGE_PENDING = page(
  'Банк подключён',
  'Доступ к банку получен. Осталось выбрать счёт в настройках приложения — до этого выписка не запрашивается.'
)
const OK_PAGE_ACCOUNT = page('Счёт подключён', 'Банковский счёт подключён к порталу. Импорт выписки начнётся автоматически.')
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
  if (!state) {
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

  // 3) Exchange code → tokens. Provider-specific: Alfa puts client_secret in the BODY, Prior uses
  //    client_secret_basic (creds in the Authorization header). Neither is ever logged.
  const isPrior = state.provider === 'prior-by'
  const priorConfig = isPrior ? deps.priorConfig() : null
  const config = isPrior ? null : deps.config(state.provider)
  const clientSecret = isPrior ? '' : deps.clientSecret(state.provider)
  if (!priorConfig && (!config || !clientSecret)) {
    deps.log?.(`[bank-connect] callback: provider ${state.provider} not configured for exchange`)
    return { status: 400, html: ERR_PAGE }
  }

  let tokens: { accessToken: string, refreshToken: string, expiresIn: number }
  try {
    if (priorConfig) {
      // ⚠ From `tokenUrl`, NOT derived from `baseUrl`. This is the SAME endpoint the connect
      // preamble calls (token Б) and the refresh path calls — three call sites of one URL. Deriving
      // it here would split them again the moment the bank's authorization server and its resource
      // API sit on different hosts (the documented production shape): step 1 would reach the
      // gateway and succeed, step 4 would go to the public host and fail — the admin sees «банк
      // отклонил подключение» AFTER a successful bank login, indistinguishable from a real refusal.
      const url = priorConfig.tokenUrl
      const req = priorTokenRequest(
        buildCodeExchangeBody(code, priorConfig.redirectUri),
        deps.priorTokenAuth(priorConfig)
      )
      const raw = await deps.exchangePriorToken(url, req.body, req.headers)
      const t = parsePriorTokenResponse(raw as never)
      // Prior may omit refresh_token; store '' rather than undefined (the store's shape) — the
      // account then simply can't refresh until reconnected, same as ensureBankToken's fallback.
      tokens = { accessToken: t.accessToken, refreshToken: t.refreshToken ?? '', expiresIn: t.expiresIn }
    } else {
      const rawTokens = await deps.exchangeToken(config!.baseUrl, buildTokenExchangeBody(config!, code, clientSecret))
      tokens = parseTokenResponse(rawTokens as Record<string, unknown>)
    }
  } catch (e) {
    // Envelope included (`describeUpstreamError`): this step fails with the same opaque
    // «400 Bad Request» for a wrong `aud`, a wrong `kid`, an expired code and a missing header —
    // and it is the LAST step, after the account holder already logged into their bank.
    deps.log?.(`[bank-connect] token exchange failed: ${describeUpstreamError(e)}`)
    return { status: 502, html: EXCHANGE_ERR_PAGE }
  }

  // 4) Persist under the portal+provider+account the VERIFIED state carries.
  const hasAccount = Boolean(state.accountKey)
  await deps.saveToken({
    memberId: state.memberId,
    provider: state.provider,
    // Счёт мог не указываться на старте (#407) — тогда токен ложится под ВРЕМЕННЫЙ ключ, и UI
    // покажет строку как «счёт не выбран». Уникальность даёт nonce: два параллельных подключения
    // одного админа иначе затёрли бы друг друга.
    accountKey: state.accountKey || provisionalAccountKey(state.nonce),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: input.nowMs + tokens.expiresIn * 1000,
    // Срок СОГЛАСИЯ — из проверенного state (#503). Другие часы, чем у токена: когда согласие
    // вышло, обновлять нечего, нужен вход владельца счёта в интернет-банк. Отсутствует у Альфы
    // (согласий не выдаёт) — тогда 0 = «неизвестно», и по нему никого не хоронят.
    consentExpiresAt: state.consentExpiresAt ?? 0
  })
  deps.log?.(`[bank-connect] connected ${state.provider} account for member ${state.memberId}`)
  return { status: 200, html: hasAccount ? OK_PAGE_ACCOUNT : OK_PAGE_PENDING }
}
