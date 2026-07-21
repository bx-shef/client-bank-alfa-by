// POST /api/distribution/provision — provision (create/verify) the two distribution smart processes
// and persist their entityTypeIds to portal settings (#109, §9.1). Auth = the B24 FRAME access token
// (Authorization: Bearer) + X-B24-Domain, admin-gated (same model as /api/poll-now). Feature is ON by
// default at this dev stage (opt OUT with DISTRIBUTION_PROVISION_ENABLED=0) — it CREATES smart
// processes on the portal. Thin I/O over the pure handler (server/utils/provisionRequest.ts).

import { handleProvisionRequest, type ProvisionRequestDeps } from '../../utils/provisionRequest'
import { handleProvisionDistribution } from '../../utils/distributionProvisionHandler'
import { provisionDistributionSp, type KnownSpIds } from '../../utils/distributionSpProvision'
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
import { SETTINGS_KEY, parsePortalSettings, serializePortalSettings, type PortalSettings } from '../../../app/utils/settings'

function liveProvisionDeps(): ProvisionRequestDeps {
  return {
    // App-side gate: default ON at this dev stage (opt OUT with DISTRIBUTION_PROVISION_ENABLED=0).
    enabled: distributionEnabled(),
    memberIdByDomain: async domain => (await getMemberIdByDomain(dbQuery, domain)) ?? '',
    validateFrame: async (domain, accessToken) => {
      // `profile` proves the token works for THIS portal (else B24 throws) + returns the ADMIN flag.
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    provision: async (memberId) => {
      // Run on the portal's STORED OAuth token (app context — proven for crm.type.add /
      // userfieldconfig.add / app.option.set, the same transport crm-sync mutations use). The frame
      // token only gated membership + admin above. Each call flows through the SDK transport's
      // withDependencySpan; the compound op gets a root span.
      const call = await livePortalSdkCall(memberId)
      if (!call) throw new Error('portal OAuth token unavailable') // → 502
      const loadSettings = async (): Promise<PortalSettings> => {
        const res = await call('app.option.get', {})
        return parsePortalSettings(pickAppOption(res, SETTINGS_KEY))
      }
      const saveSettings = async (settings: PortalSettings): Promise<void> => {
        await call('app.option.set', { options: { [SETTINGS_KEY]: serializePortalSettings(settings) } })
      }
      return withSpan('provision-sp', { 'portal.hash': portalHash(memberId) }, () =>
        handleProvisionDistribution({
          loadSettings,
          saveSettings,
          provision: (known: KnownSpIds) => provisionDistributionSp(call, known),
          // Single-flight per portal: serialize concurrent provision requests across replicas.
          withLock: fn => withAdvisoryLock(`provision-sp:${memberId}`, () => fn())
        }))
    }
  }
}

// Outer http-route span (телеметрия, DEFAULT OFF): latency + PII-safe outcome (incl. admin-gate
// `forbidden`) + hashed portal id; the inner `provision-sp` span carries the compound SP op.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.distribution-provision.post', method: 'POST', op: 'distribution.provision', domain },
    async (span) => {
      const { status, body } = await handleProvisionRequest(liveProvisionDeps(), { accessToken: token, domain })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
