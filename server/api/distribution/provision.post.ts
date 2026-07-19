// POST /api/distribution/provision — provision (create/verify) the two distribution smart processes
// and persist their entityTypeIds to portal settings (#109, §9.1). Auth = the B24 FRAME access token
// (Authorization: Bearer) + X-B24-Domain, admin-gated (same model as /api/poll-now). Feature is OFF
// unless DISTRIBUTION_PROVISION_ENABLED=1 (fail-closed) — the owner opts portals in, since it CREATES
// smart processes on the portal. Thin I/O over the pure handler (server/utils/provisionRequest.ts).

import { handleProvisionRequest, type ProvisionRequestDeps } from '../../utils/provisionRequest'
import { handleProvisionDistribution } from '../../utils/distributionProvisionHandler'
import { provisionDistributionSp, type KnownSpIds } from '../../utils/distributionSpProvision'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall, livePortalSdkCall } from '../../utils/liveDeps'
import { pickAppOption } from '../../utils/appSettings'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { withAdvisoryLock } from '../../utils/dbLock'
import { withSpan } from '../../utils/telemetrySpan'
import { portalHash } from '../../utils/telemetryAttributes'
import { dbQuery } from '../../db/client'
import { SETTINGS_KEY, parsePortalSettings, serializePortalSettings, type PortalSettings } from '../../../app/utils/settings'

function liveProvisionDeps(): ProvisionRequestDeps {
  return {
    // App-side gate: default OFF (creates smart processes — opt-in per owner).
    enabled: process.env.DISTRIBUTION_PROVISION_ENABLED === '1',
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

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const { status, body } = await handleProvisionRequest(liveProvisionDeps(), { accessToken: token, domain })
  setResponseStatus(event, status)
  return body
})
