// GET /api/bank/accounts — the caller portal's connected bank accounts for the settings UI (#404).
// Auth = B24 frame access token (Authorization: Bearer) + X-B24-Domain, admin-only — the same model
// and the same gate as /api/bank/connect, because listing bank bindings is the read half of that
// capability. Thin I/O over the pure handler (server/utils/bankAccounts.ts).
//
// Returns identity + freshness only; access/refresh tokens never leave the server.

import { handleListBankAccounts, type ListAccountsDeps } from '../../utils/bankAccounts'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { listBankAccountInfoForPortal } from '../../utils/bankTokenStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

function liveDeps(): ListAccountsDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      // `profile` proves the token belongs to THIS portal (else B24 throws) and carries ADMIN.
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    list: memberId => listBankAccountInfoForPortal(dbQuery, memberId)
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.bank-accounts.get', method: 'GET', op: 'bank.accounts.list', domain },
    async (span) => {
      const { status, body } = await handleListBankAccounts(liveDeps(), { accessToken: token, domain })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
