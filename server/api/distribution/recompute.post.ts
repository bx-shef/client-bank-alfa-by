// POST /api/distribution/recompute — recompute «осталось распределить» for every payment carrier of
// the portal (#109 §3/§9.2 «пересчитать» — the manual recovery backstop). Auth = the B24 FRAME access
// token (Authorization: Bearer) + X-B24-Domain, admin-gated. Feature ON by default (opt OUT with
// DISTRIBUTION_PROVISION_ENABLED=0). Single-flight per portal (advisory lock, same as provisioning).
// Thin I/O over the pure handler (server/utils/recomputeRequest.ts); the SP writes run on the portal's
// STORED OAuth token.

import { handleRecomputeRequest, type RecomputeRequestDeps } from '../../utils/recomputeRequest'
import { recomputeAllPayments } from '../../utils/distributionLedgerWrite'
import { bearerToken } from '../../utils/settingsHandler'
import { distributionEnabled } from '../../utils/distributionEnabled'
import { frameRestCall, livePortalSdkCall } from '../../utils/liveDeps'
import { pickAppOption } from '../../utils/appSettings'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { withAdvisoryLock } from '../../utils/dbLock'
import { withSpan } from '../../utils/telemetrySpan'
import { portalHash, httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { dbQuery } from '../../db/client'
import { distributionSpRef, paymentSpRef } from '../../../app/config/distributionSp'
import { SETTINGS_KEY, parsePortalSettings } from '../../../app/utils/settings'

function liveRecomputeDeps(): RecomputeRequestDeps {
  return {
    enabled: distributionEnabled(),
    memberIdByDomain: async domain => (await getMemberIdByDomain(dbQuery, domain)) ?? '',
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    recompute: async (memberId) => {
      const call = await livePortalSdkCall(memberId)
      if (!call) return null
      const cf = parsePortalSettings(pickAppOption(await call('app.option.get', {}), SETTINGS_KEY)).recognition.configFields
      const paymentRef = paymentSpRef(cf)
      const distRef = distributionSpRef(cf)
      if (!paymentRef || !distRef) return null // SPs not provisioned
      // Single-flight per portal: serialize concurrent recomputes (and vs the crm-sync/deletion writers
      // touching the same «осталось» fields) — same advisory lock family as provisioning.
      return withAdvisoryLock(`distribution-recompute:${memberId}`, () =>
        withSpan('ledger-recompute', { 'portal.hash': portalHash(memberId) }, () => recomputeAllPayments(paymentRef, distRef, call)))
    }
  }
}

// Outer http-route span (телеметрия, DEFAULT OFF): latency + PII-safe outcome + hashed portal id;
// the inner `ledger-recompute` span carries the SP writes.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.distribution-recompute.post', method: 'POST', op: 'distribution.recompute', domain },
    async (span) => {
      const { status, body } = await handleRecomputeRequest(liveRecomputeDeps(), { accessToken: token, domain })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
