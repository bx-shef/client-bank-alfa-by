// POST /api/import/metrics-reset — clear the portal's lifetime counters (#78), the
// operator's «сбросить метрики». Auth = the B24 frame token (Authorization: Bearer) +
// X-B24-Domain, member-scoped (a portal only ever resets its own counters). Thin I/O
// over the pure handler; live deps are shared with the read route (metricsRouteDeps.ts).

import { handleMetricsReset } from '../../utils/metricsHandler'
import { liveMetricsDeps } from '../../utils/metricsRouteDeps'
import { bearerToken } from '../../utils/settingsHandler'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'

// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + PII-safe outcome (incl. the
// admin-gate `forbidden`) + hashed portal id.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.import-metrics-reset.post', method: 'POST', op: 'metrics.reset', domain },
    async (span) => {
      const { status, body } = await handleMetricsReset(liveMetricsDeps(), { accessToken: token, domain })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
