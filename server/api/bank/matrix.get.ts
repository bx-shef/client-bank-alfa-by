// GET /api/bank/matrix — «наш счёт ↔ счёт в банке» (#494): the settlement accounts CRM holds on
// «мои компании» next to the accounts the connected banks actually report, and the matrix computed
// from the two. Auth = B24 frame token + X-B24-Domain, admin-only — the same gate as the rest of
// /api/bank/*. Thin I/O over the pure handler (server/utils/bankMatrix.ts).

import { handleBankMatrix, type BankMatrixDeps } from '../../utils/bankMatrix'
import { findMyCompanyAccounts } from '../../utils/myCompanyRequisites'
import { listBankSideAccounts, connectedKeys } from '../../utils/bankAccountList'
import { bankSideDeps } from '../../utils/bankSideDeps'
import { BANK_REFRESH_LOCK_WAIT } from '../../utils/dbLock'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { listBankTokensForPortal } from '../../utils/bankTokenStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

function liveDeps(): BankMatrixDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    myCompanies: (domain, accessToken) =>
      findMyCompanyAccounts((method, params) => frameRestCall(domain, accessToken, method, params)),
    // ⚠ Ожидание лока — КОРОТКОЕ (#539): на том конце человек, открывший экран сверки. Дождаться
    // держателя (сетевой POST к банку до 15 с) нельзя — можно только не мешать.
    bankSide: memberId => listBankSideAccounts(memberId, bankSideDeps(BANK_REFRESH_LOCK_WAIT)),
    connected: async memberId => connectedKeys(await listBankTokensForPortal(dbQuery, memberId))
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.bank-matrix.get', method: 'GET', op: 'bank.matrix', domain },
    async (span) => {
      const { status, body } = await handleBankMatrix(liveDeps(), { accessToken: token, domain })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
