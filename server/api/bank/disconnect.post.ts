// POST /api/bank/disconnect — remove ONE connected bank account of the caller's portal (#404).
// Auth = B24 frame access token + X-B24-Domain, admin-only (same gate as connect: whoever may bind
// portal-wide bank credentials may unbind them). Thin I/O over server/utils/bankAccounts.ts.
//
// The frame token is itself the CSRF defense — only the in-portal iframe holds it. Deletion is
// member-scoped in SQL, so a forged id/accountKey can only ever hit the caller's own rows.
//
// ⚠ Addressed by the row's immutable `id`, not by the account number (#517): the number CHANGES
// when the admin picks an account for a pending connection, so a delete aimed at the number the
// browser rendered found nothing and answered the same `200 {removed:false}` as honest
// idempotency — reporting success while the app kept reaching into the client's bank.

import { handleDisconnectBankAccount, type DisconnectDeps } from '../../utils/bankAccounts'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { deleteBankTokenById } from '../../utils/bankTokenStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

function liveDeps(): DisconnectDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    remove: (memberId, id, expectedAccountKey) => deleteBankTokenById(dbQuery, memberId, id, expectedAccountKey)
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  // A malformed/absent body must not 500 — it falls through to the handler's 400.
  const raw = await readBody<{ provider?: unknown, accountKey?: unknown, id?: unknown }>(event)
    .catch(() => ({} as { provider?: unknown, accountKey?: unknown, id?: unknown }))
  return withFrameRouteSpan(
    { name: 'http.bank-disconnect.post', method: 'POST', op: 'bank.accounts.remove', domain },
    async (span) => {
      const { status, body } = await handleDisconnectBankAccount(liveDeps(), {
        accessToken: token,
        domain,
        provider: typeof raw?.provider === 'string' ? raw.provider : '',
        accountKey: typeof raw?.accountKey === 'string' ? raw.accountKey : '',
        // Неизменяемый адрес строки (#517); `accountKey` рядом — это ОЖИДАНИЕ вызывающего, по
        // расхождению с ним мы и узнаём, что список на экране устарел.
        id: Number(raw?.id)
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
