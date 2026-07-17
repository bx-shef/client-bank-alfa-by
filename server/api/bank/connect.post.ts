// POST /api/bank/connect — start the bank OAuth connect (stage 5, A7b-1). Auth = the B24 frame
// access token (Authorization: Bearer) + X-B24-Domain, same model as /api/import. Body: { provider }.
// Returns { authorizeUrl } for the in-portal admin UI to open at the TOP level; the bank then
// redirects to the callback (A7b-2). Thin I/O over the pure handler (server/utils/bankConnectStart.ts).
//
// The frame token is itself the CSRF defense (it can't be replayed cross-site — only the in-portal
// iframe holds it). The signed state carries OUR resolved memberId (not a client value), so the
// callback can trust it. No secret ⇒ 503 (fail-closed). Referrer-Policy is set defensively (the
// response body carries a URL with a signed state; keep it out of any downstream Referer).

import { randomBytes } from 'node:crypto'
import { bankConnectConfigFromEnv, handleBankConnectStart, type ConnectStartDeps } from '../../utils/bankConnectStart'
import { bearerToken } from '../../utils/settingsHandler'
import { resolveAuthConfig } from '../../utils/session'
import { callRest } from '../../utils/b24Rest'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { dbQuery } from '../../db/client'
import type { BankProviderId } from '../../../app/types/statement'

function liveConnectDeps(): ConnectStartDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      // `profile` (basic scope) proves the token works for THIS portal (else B24 throws) and
      // returns the user's id + ADMIN flag in one call — both membership and the admin gate.
      const res = await callRest(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    config: bankConnectConfigFromEnv,
    secret: resolveAuthConfig(process.env).secret
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const body = await readBody(event).catch(() => null) as { provider?: string } | null
  const provider = (body?.provider || '').trim() as BankProviderId

  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  const { status, body: out } = await handleBankConnectStart(liveConnectDeps(), {
    accessToken: token,
    domain,
    provider,
    nonce: randomBytes(16).toString('hex'),
    nowMs: Date.now()
  })
  setResponseStatus(event, status)
  return out
})
