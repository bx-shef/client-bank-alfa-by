// GET /api/bank/callback — bank OAuth redirect landing (stage 5, A7b-2). Runs at the TOP level
// (the bank redirects the admin's browser here after consent, outside the iframe). Auth is the
// SIGNED state carried in the query — there is no frame token on a bank redirect. Thin I/O over the
// pure handler (server/utils/bankConnectCallback.ts): verify state → exchange code → saveBankToken.
// Renders an HTML page. This URL must EXACTLY match the redirect URI registered with each bank
// (ALFA_OAUTH_REDIRECT_URI / PRIOR_OAUTH_REDIRECT_URI) — both providers land here and are told apart
// by the verified state's `provider`.

import { randomUUID } from 'node:crypto'
import { handleBankConnectCallback, type CallbackDeps } from '../../utils/bankConnectCallback'
import { bankConnectConfigFromEnv } from '../../utils/bankConnectStart'
import { priorConnectConfigFromEnv } from '../../utils/priorConnectStart'
import { resolvePriorTokenAuth } from '../../utils/priorTokenAuth'
import { signPriorJwt } from '../../utils/priorJwt'
import { resolveAuthConfig } from '../../utils/session'
import { saveBankToken } from '../../utils/bankTokenStore'
import { dbQuery } from '../../db/client'
import type { BankProviderId } from '../../../app/types/statement'

/**
 * Patience for the code→token exchange. Deliberately far longer than our other outbound calls.
 *
 * This is the only step whose failure lands on a person who has ALREADY typed their internet-bank
 * password: the code is single-use, so a timeout here means «начните заново, войдите в банк ещё
 * раз», and the page cannot tell them apart from a real refusal. Measured against Priorbank's
 * sandbox (2026-08-14) the `authorization_code` grant is markedly slower than `client_credentials`
 * on the same endpoint — one live connect blew through 15s and showed «банк отклонил подключение»
 * to an account holder who had done everything right, while the very next attempt succeeded.
 *
 * The cost of waiting is one held request on our side; the cost of not waiting is another trip
 * through someone else's bank login. Not unbounded, though — a hung upstream must still end.
 */
const TOKEN_EXCHANGE_TIMEOUT_MS = 60_000

function liveCallbackDeps(): CallbackDeps {
  return {
    secret: resolveAuthConfig(process.env).secret,
    config: bankConnectConfigFromEnv,
    clientSecret: (provider: BankProviderId) =>
      provider === 'alfa-by' ? (process.env.ALFA_OAUTH_CLIENT_SECRET?.trim() || '') : '',
    exchangeToken: async (baseUrl, body) => {
      const post = $fetch as unknown as (
        url: string,
        opts: { method: string, body: string, headers: Record<string, string>, timeout: number }
      ) => Promise<unknown>
      // client_secret rides in `body` — do NOT log opts anywhere.
      return post(`${baseUrl}/token`, {
        method: 'POST',
        body: body.toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        timeout: TOKEN_EXCHANGE_TIMEOUT_MS
      })
    },
    priorConfig: priorConnectConfigFromEnv,
    // Client authentication is resolved upstream (`priorTokenAuth` below → `priorTokenRequest`,
    // #444): under client_secret_basic the creds ride in `headers`, under private_key_jwt the
    // signed assertion rides in `body`. Do NOT log `opts` anywhere — it carries one or the other.
    exchangePriorToken: async (url, body, headers) => {
      const post = $fetch as unknown as (
        url: string,
        opts: { method: string, body: string, headers: Record<string, string>, timeout: number }
      ) => Promise<unknown>
      return post(url, {
        method: 'POST',
        body,
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        timeout: TOKEN_EXCHANGE_TIMEOUT_MS
      })
    },
    priorTokenAuth: config => resolvePriorTokenAuth(config.authMethod ?? 'client_secret_basic', config, {
      signJwt: signPriorJwt,
      nowSec: () => Math.floor(Date.now() / 1000),
      newId: () => randomUUID()
    }),
    saveToken: token => saveBankToken(dbQuery, token),
    log: msg => console.info(msg)
  }
}

export default defineEventHandler(async (event) => {
  const { status, html } = await handleBankConnectCallback(liveCallbackDeps(), {
    query: getQuery(event) as Record<string, string | string[] | undefined>,
    nowMs: Date.now()
  })
  setResponseStatus(event, status)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  return html
})
