// POST /api/distribution/provision — provision (create/verify) the two distribution smart processes
// and persist their entityTypeIds to portal settings (#109, §9.1). Auth = the B24 FRAME access token
// (Authorization: Bearer) + X-B24-Domain, admin-gated (same model as /api/poll-now).
//
// ⚠ NO feature flag any more (owner's call, 2026-08-23): the payments smart process is not an
// optional extra, it is the REGISTRY every operation is written to (#575). A portal without it
// imports into a void, so the app's mode is «always on» and the only gates left are the ones that
// answer «who may do this»: the frame token proves the portal, `profile.ADMIN` proves the person.
// Thin I/O over the pure handler (server/utils/provisionRequest.ts).

import { handleProvisionRequest, type ProvisionRequestDeps } from '../../utils/provisionRequest'
import { handleProvisionDistribution } from '../../utils/distributionProvisionHandler'
import { provisionDistributionSp, type KnownSpIds } from '../../utils/distributionSpProvision'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall, liveLeaseDeps, livePortalSdkCall } from '../../utils/liveDeps'
import { pickAppOption } from '../../utils/appSettings'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { provisionLeaseKey, SINGLE_FLIGHT_LEASE_SEC, withSingleFlightLease } from '../../utils/singleFlightLease'
import { withSpan } from '../../utils/telemetrySpan'
import { portalHash, httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { dbQuery } from '../../db/client'
import { SETTINGS_KEY, parsePortalSettings, serializePortalSettings, type PortalSettings } from '../../../app/utils/settings'
import { useServerLogger } from '../../utils/serverLogger'

const log = useServerLogger('queue')

function liveProvisionDeps(): ProvisionRequestDeps {
  return {
    memberIdByDomain: async domain => (await getMemberIdByDomain(dbQuery, domain)) ?? '',
    validateFrame: async (domain, accessToken) => {
      // `profile` proves the token works for THIS portal (else B24 throws) + returns the ADMIN flag.
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    // Raw portal error → server log only (the client gets the classified text). Injected so the
    // pure handler stays free of console.*.
    log: message => log.warning(message),
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
          //
          // ⚠ Это АРЕНДА, а не advisory-лок (#538). Разница не в способе, а в том, что удерживается:
          // лок держал соединение из пула всю REST-цепочку (~18 последовательных вызовов), ни разу
          // не обратившись к базе, — пул общий на 10, и десяток провижинингов с РАЗНЫХ порталов
          // выедал его целиком, роняя readiness-пробу и приём событий установки. Аренда берёт
          // соединение дважды по одному запросу и отдаёт сразу.
          //
          // ⚠ Ждать не пытаемся вовсе (у лока было короткое ожидание): дождаться держателя нельзя,
          // а второму вызывающему нечего делать — первый создаёт всё то же самое. Ответ «уже
          // выполняется» и есть правильный.
          withLock: fn => withSingleFlightLease(liveLeaseDeps(), provisionLeaseKey(memberId), SINGLE_FLIGHT_LEASE_SEC, fn)
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
