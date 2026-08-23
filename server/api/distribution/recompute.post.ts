// POST /api/distribution/recompute — recompute «осталось распределить» for every payment carrier of
// the portal (#109 §3/§9.2 «пересчитать» — the manual recovery backstop). Auth = the B24 FRAME access
// token (Authorization: Bearer) + X-B24-Domain, admin-gated. Single-flight per portal (аренда, как
// у провижининга).
// Thin I/O over the pure handler (server/utils/recomputeRequest.ts); the SP writes run on the portal's
// STORED OAuth token.

import { handleRecomputeRequest, type RecomputeRequestDeps } from '../../utils/recomputeRequest'
import { recomputeAllPayments } from '../../utils/distributionLedgerWrite'
import { bearerToken } from '../../utils/settingsHandler'
import { frameRestCall, liveLeaseDeps, livePortalSdkCall } from '../../utils/liveDeps'
import { pickAppOption } from '../../utils/appSettings'
import { getMemberIdByDomain } from '../../utils/tokenStore'
import { recomputeLeaseKey, SINGLE_FLIGHT_LEASE_SEC, withSingleFlightLease } from '../../utils/singleFlightLease'
import { withSpan } from '../../utils/telemetrySpan'
import { portalHash, httpOutcomeForStatus } from '../../utils/telemetryAttributes'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { dbQuery } from '../../db/client'
import { distributionSpRef, paymentSpRef } from '../../../app/config/distributionSp'
import { useServerLogger } from '../../utils/serverLogger'
import { SETTINGS_KEY, parsePortalSettings } from '../../../app/utils/settings'

function liveRecomputeDeps(): RecomputeRequestDeps {
  return {
    log: message => useServerLogger('queue').warning(message),
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
      // Single-flight per portal: сериализует пересчёты между собой.
      //
      // ⚠ И ТОЛЬКО их. Здесь годами стояло «and vs the crm-sync/deletion writers touching the same
      // «осталось» fields» — это неправда: ключ `distribution-recompute:` не берёт ни один воркер,
      // и пересчёт с crm-sync пишут одно и то же поле конкурентно, как и раньше. Обещание
      // взаимного исключения, которого нет, опаснее его отсутствия: на него ссылаются, объясняя,
      // почему где-то ещё защиты не нужно.
      //
      // ⚠ Это АРЕНДА, а не advisory-лок (#538), и здесь причина острее, чем у провижининга: этот
      // держатель обходит КАЖДЫЙ платёж портала по два REST-вызова (до `MAX_LEDGER_PAYMENTS`), то
      // есть работает минутами — и всё это время advisory-лок держал соединение из общего пула
      // (10), не делая с базой ничего. Аренда занимает соединение дважды по одному запросу.
      //
      // ⚠ Срок аренды поэтому втрое длиннее провижининга, а ждать её не пытаемся: второму
      // вызывающему нечего делать — первый проходит те же самые элементы.
      return withSingleFlightLease(liveLeaseDeps(), recomputeLeaseKey(memberId), SINGLE_FLIGHT_LEASE_SEC, () =>
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
