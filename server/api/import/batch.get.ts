// GET /api/import/batch?ids=<sha256>,<sha256> — итоги конкретных ручных загрузок (#417).
// Авторизация — фрейм-токен (Bearer + X-B24-Domain), как у `/api/import`. Тонкий I/O над чистым
// обработчиком (server/utils/importBatchHandler.ts).

import { handleImportBatch, type ImportBatchDeps } from '../../utils/importBatchHandler'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { getBatchResults } from '../../utils/importBatchStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

function liveBatchDeps(): ImportBatchDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const id = (res?.result as { ID?: unknown } | undefined)?.ID
      return id != null ? String(id) : ''
    },
    getBatches: (memberId, ids) => getBatchResults(dbQuery, memberId, ids)
  }
}

// Ручной OTel-спан (телеметрия, DEFAULT OFF): только исход + хеш портала; ни ключей загрузок,
// ни имён файлов, ни счётчиков в спан не кладём.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const ids = String(getQuery(event).ids ?? '')
  return withFrameRouteSpan(
    { name: 'http.import-batch.get', method: 'GET', op: 'import.batch', domain },
    async (span) => {
      const { status, body } = await handleImportBatch(liveBatchDeps(), { accessToken: token, domain, ids })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
