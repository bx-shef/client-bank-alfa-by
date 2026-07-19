// GET /api/distribution/ledger — the portal's distribution ledger (payment carriers + their rows)
// for the «Распределение» UI (#109 §9.3 #4). Auth = the B24 FRAME access token (Authorization:
// Bearer) + X-B24-Domain, admin-gated. Feature OFF unless DISTRIBUTION_PROVISION_ENABLED=1 (same gate
// as provisioning). Thin I/O over the pure handler (server/utils/ledgerRequest.ts); the SP read runs
// on the portal's STORED OAuth token.

import { handleLedgerRequest, type LedgerRequestDeps } from '../../utils/ledgerRequest'
import { loadPortalLedger } from '../../utils/distributionLedgerWrite'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall, livePortalSdkCall } from '../../utils/liveDeps'
import { pickAppOption } from '../../utils/appSettings'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { withSpan } from '../../utils/telemetrySpan'
import { portalHash } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'
import { distributionSpEtid, paymentSpEtid } from '../../../app/config/distributionSp'
import { SETTINGS_KEY, parsePortalSettings } from '../../../app/utils/settings'

function liveLedgerDeps(): LedgerRequestDeps {
  return {
    enabled: process.env.DISTRIBUTION_PROVISION_ENABLED === '1',
    memberIdByDomain: async domain => (await getMemberIdByDomain(dbQuery, domain)) ?? '',
    validateFrame: async (domain, accessToken) => {
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    loadLedger: async (memberId) => {
      const call = await livePortalSdkCall(memberId)
      if (!call) return null
      const cf = parsePortalSettings(pickAppOption(await call('app.option.get', {}), SETTINGS_KEY)).recognition.configFields
      const paymentEtid = paymentSpEtid(cf)
      const distEtid = distributionSpEtid(cf)
      if (!paymentEtid || !distEtid) return null // SPs not provisioned → UI shows a setup prompt
      return withSpan('ledger-read', { 'portal.hash': portalHash(memberId) }, () => loadPortalLedger(paymentEtid, distEtid, call))
    }
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const { status, body } = await handleLedgerRequest(liveLedgerDeps(), { accessToken: token, domain })
  setResponseStatus(event, status)
  return body
})
