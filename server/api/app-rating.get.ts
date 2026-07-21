// GET /api/app-rating — should the in-portal «оцените приложение» modal be shown for this portal?
// Frame-token authenticated (Bearer + X-B24-Domain, same model as /api/import/status): member_id
// is resolved from the domain and the token is validated via `profile` — never trusted from the
// client. Side-effect-free: it only READS state; the client stamps prompted_at via POST when the
// modal actually renders. Any failure degrades to { show: false } — the UI must never nag or error.

import { handleAppRatingShow, type AppRatingShowDeps } from '../utils/appRatingHandler'
import { bearerToken } from '../utils/settingsHandler'
import { frameRestCall } from '../utils/liveDeps'
import { getMemberIdByDomain } from '../utils/tokenStore'
import { getRatingState } from '../utils/appRatingStore'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { dbQuery } from '../db/client'

function liveShowDeps(): AppRatingShowDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const id = (res?.result as { ID?: unknown } | undefined)?.ID
      return id != null ? String(id) : ''
    },
    getState: memberId => getRatingState(memberId, dbQuery),
    now: () => new Date()
  }
}

// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + PII-safe outcome + hashed
// portal id, never the state payload.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.app-rating.get', method: 'GET', op: 'app-rating.show', domain },
    async (span) => {
      try {
        const { body } = await handleAppRatingShow(liveShowDeps(), { accessToken: token, domain })
        return body
      } catch {
        // A DB/transport failure must never break the in-portal UI — stay silent.
        span.outcome = 'upstream_error'
        return { show: false }
      }
    }
  )
})
