// GET /api/import/status — the portal's last import run (#5), for the in-portal UI.
// Auth = the B24 frame access token (Authorization: Bearer) + X-B24-Domain, same model
// as /api/import. Thin I/O over the pure handler (server/utils/importStatusHandler.ts).

import { handleImportStatus, type ImportStatusDeps } from '../../utils/importStatusHandler'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall } from '../../utils/liveDeps'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { getImportResult } from '../../utils/importResultStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'

function liveStatusDeps(): ImportStatusDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const id = (res?.result as { ID?: unknown } | undefined)?.ID
      return id != null ? String(id) : ''
    },
    getResult: memberId => getImportResult(dbQuery, memberId)
  }
}

// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + PII-safe outcome + hashed
// portal id, never the run summary.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.import-status.get', method: 'GET', op: 'import.status', domain },
    async (span) => {
      const { status, body } = await handleImportStatus(liveStatusDeps(), { accessToken: token, domain })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
