// GET /api/import/metrics — the portal's lifetime metric counters (#78), for the
// in-portal dashboard. Auth = the B24 frame token (Authorization: Bearer) + X-B24-Domain,
// same model as /api/import/status. Thin I/O over the pure handler (metricsHandler.ts);
// live deps are shared with the reset route (metricsRouteDeps.ts).

import { handleMetrics } from '../../utils/metricsHandler'
import { liveMetricsDeps } from '../../utils/metricsRouteDeps'
import { bearerToken } from '../../utils/settingsHandler'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { httpOutcomeForStatus } from '../../utils/telemetryAttributes'

// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + PII-safe outcome + hashed
// portal id, never the counters payload.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  return withFrameRouteSpan(
    { name: 'http.import-metrics.get', method: 'GET', op: 'metrics.load', domain },
    async (span) => {
      const { status, body } = await handleMetrics(liveMetricsDeps(), { accessToken: token, domain })
      span.outcome = httpOutcomeForStatus(status)
      setResponseStatus(event, status)
      return body
    }
  )
})
