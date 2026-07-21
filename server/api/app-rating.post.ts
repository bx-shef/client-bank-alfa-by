// POST /api/app-rating — record a rating-prompt lifecycle event for this portal.
//   { action: 'prompted' } — the modal was shown (throttle for RATING_REPROMPT_DAYS).
//   { action: 'opened' }   — the user clicked «Оценить» → we opened the Market page. Suppresses the
//                            modal until an owner MANUALLY verifies whether a review appeared.
// Frame-token authenticated (Bearer + X-B24-Domain — member_id from the verified domain). The
// client ignores errors (a failed state write must never break the UX), but we return a status.

import { handleAppRatingReport, type AppRatingReportDeps } from '../utils/appRatingHandler'
import { bearerToken } from '../utils/settingsHandler'
import { frameRestCall } from '../utils/liveDeps'
import { getMemberIdByDomain } from '../utils/tokenStore'
import { markOpened, markPrompted } from '../utils/appRatingStore'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../utils/telemetryAttributes'
import { dbQuery } from '../db/client'

function liveReportDeps(): AppRatingReportDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const id = (res?.result as { ID?: unknown } | undefined)?.ID
      return id != null ? String(id) : ''
    },
    markPrompted: memberId => markPrompted(memberId, dbQuery),
    markOpened: memberId => markOpened(memberId, dbQuery)
  }
}

// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + PII-safe outcome + hashed
// portal id, never the action payload.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.app-rating.post', method: 'POST', op: 'app-rating.report', domain },
    async (span) => {
      const body = await readBody(event).catch(() => null) as { action?: unknown } | null
      const { status, body: resBody } = await handleAppRatingReport(liveReportDeps(), {
        accessToken: token,
        domain,
        action: body?.action
      })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return resBody
    }
  )
})
