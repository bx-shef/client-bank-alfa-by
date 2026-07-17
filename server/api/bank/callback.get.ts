// GET /api/bank/callback — bank OAuth redirect landing (stage 5, A7b-2). Runs at the TOP level
// (the bank redirects the admin's browser here after consent, outside the iframe). Auth is the
// SIGNED state carried in the query — there is no frame token on a bank redirect. Thin I/O over the
// pure handler (server/utils/bankConnectCallback.ts): verify state → exchange code → saveBankToken.
// Renders an HTML page. This URL must EXACTLY match ALFA_OAUTH_REDIRECT_URI.

import { handleBankConnectCallback, type CallbackDeps } from '../../utils/bankConnectCallback'
import { bankConnectConfigFromEnv } from '../../utils/bankConnectStart'
import { resolveAuthConfig } from '../../utils/session'
import { saveBankToken } from '../../utils/bankTokenStore'
import { dbQuery } from '../../db/client'
import type { BankProviderId } from '../../../app/types/statement'

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
        timeout: 15_000
      })
    },
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
