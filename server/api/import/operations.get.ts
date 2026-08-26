// GET /api/import/operations — «Последние операции» портала для главного экрана (#5/#36). Читает
// элементы смарт-процесса «Платежи» (реестр #575) и разворачивает их в StatementItem. Auth = B24
// frame token + X-B24-Domain (member-scoped, НЕ admin — витрина для любого сотрудника). Чтение SP
// идёт на СТОРЕДНОМ OAuth-токене портала (как /api/distribution/ledger), тонкий I/O над чистым
// хендлером (server/utils/recentOperationsHandler.ts).

import { handleRecentOperations, type RecentOperationsDeps } from '../../utils/recentOperationsHandler'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall, livePortalSdkCall } from '../../utils/liveDeps'
import { extractListItems } from '../../utils/distributionLedgerWrite'
import { pickAppOption } from '../../utils/appSettings'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { withSpan } from '../../utils/telemetrySpan'
import { portalHash, httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { dbQuery } from '../../db/client'
import { paymentSpRef } from '../../../app/config/distributionSp'
import { SETTINGS_KEY, parsePortalSettings } from '../../../app/utils/settings'
import { buildRecentOperationsListCall, mapRecentOperations } from '../../../app/utils/recentOperations'

function liveDeps(): RecentOperationsDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown } | undefined
      return result?.ID != null ? String(result.ID) : ''
    },
    loadOperations: async (memberId) => {
      const call = await livePortalSdkCall(memberId)
      if (!call) return null
      const cf = parsePortalSettings(pickAppOption(await call('app.option.get', {}), SETTINGS_KEY)).recognition.configFields
      const paymentRef = paymentSpRef(cf)
      if (!paymentRef) return null // СП «Платежи» не создан → витрина покажет пустое состояние
      return withSpan('recent-ops-read', { 'portal.hash': portalHash(memberId) }, async () => {
        const listCall = buildRecentOperationsListCall(paymentRef)
        const res = await call(listCall.method, listCall.params)
        return mapRecentOperations(extractListItems(res), paymentRef)
      })
    }
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.import-operations.get', method: 'GET', op: 'import.operations', domain },
    async (span) => {
      const { status, body } = await handleRecentOperations(liveDeps(), { accessToken: token, domain })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
