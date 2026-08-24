// GET /api/bank/matrix — «наш счёт ↔ счёт в банке» (#494): the settlement accounts CRM holds on
// «мои компании» next to the accounts the connected banks actually report, and the matrix computed
// from the two. Auth = B24 frame token + X-B24-Domain, admin-only — the same gate as the rest of
// /api/bank/*. Thin I/O over the pure handler (server/utils/bankMatrix.ts).

import { handleBankMatrix, type BankMatrixDeps } from '../../utils/bankMatrix'
import { findMyCompanyAccounts } from '../../utils/myCompanyRequisites'
import { accountsRequestHeaders, listBankSideAccounts, connectedKeys, type BankSideListDeps } from '../../utils/bankAccountList'
import { bankApiConfig } from '../../utils/bankFetch'
import { ensureBankToken } from '../../utils/ensureBankToken'
import { BANK_REFRESH_LOCK_WAIT } from '../../utils/dbLock'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { listBankTokensForPortal } from '../../utils/bankTokenStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { randomUUID } from 'node:crypto'
import type { BankProviderId } from '../../../app/types/statement'
import { dbQuery } from '../../db/client'

/**
 * GET a JSON resource with the provider's own headers. The auth header never appears in the thrown
 * message — only the status and the upstream text, which the caller sanitises.
 *
 * ⚠ ЗАГОЛОВКИ ЗАВИСЯТ ОТ БАНКА (#20). Приор проверяет заголовок взаимодействия FAPI на ЛЮБОМ вызове и
 * делает это ДО тела (#461): запрос с одним `Authorization` он отвергает. Прежняя версия слала
 * ровно его, и счета Приора в сверке не появлялись НИКОГДА — а поскольку отказ здесь fail-soft по
 * провайдеру, выглядело это как «банк их не отдаёт», то есть указывало не на ту сторону.
 * ⚠ Сам ВЫБОР заголовков — в чистом `accountsRequestHeaders`, и там же общий билдер заголовков
 * Приора: здесь утверждение «для Приора шлём его заголовки» было бы непроверяемым.
 */
async function getJson(provider: BankProviderId, url: string, accessToken: string): Promise<unknown> {
  const fetchJson = $fetch as unknown as (
    url: string,
    opts: { method: string, headers: Record<string, string>, timeout: number }
  ) => Promise<unknown>
  // Выбор заголовков — в чистом `accountsRequestHeaders`: здесь он был бы непроверяем, а
  // ошибиться в нём значит потерять счета целого банка молча (#20).
  const headers = accountsRequestHeaders(provider, accessToken, randomUUID())
  try {
    return await fetchJson(url, { method: 'GET', headers, timeout: 20_000 })
  } catch (e) {
    const status = (e as { status?: number })?.status
    throw new Error(`банк не ответил${status ? ` (${status})` : ''}`, { cause: e })
  }
}

function bankSideDeps(): BankSideListDeps {
  return {
    tokens: memberId => listBankTokensForPortal(dbQuery, memberId),
    // ⚠ Ожидание лока — КОРОТКОЕ (#539). Умолчание в 10 с здесь означало бы, что админ, открывший
    // экран сверки в момент планового продления токена, десять секунд держит соединение из пула
    // (пул — 10, из него же берут readiness-проба и все остальные порталы) ради шанса выиграть у
    // держателя, который сам ограничен 15 секундами. Дождаться нельзя — можно только не мешать.
    ensureFresh: token => ensureBankToken(token, undefined, { lockWait: BANK_REFRESH_LOCK_WAIT }),
    // Reuses the statement transport's config resolver, so a deployment can never end up asking
    // one host for the account list and another for the statement.
    apiBase: provider => bankApiConfig(provider)?.base ?? null,
    getJson
  }
}

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
    bankSide: memberId => listBankSideAccounts(memberId, bankSideDeps()),
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
