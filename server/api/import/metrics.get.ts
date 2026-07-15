// GET /api/import/metrics — the portal's lifetime metric counters (#78), for the
// in-portal dashboard. Auth = the B24 frame token (Authorization: Bearer) + X-B24-Domain,
// same model as /api/import/status. Thin I/O over the pure handler (metricsHandler.ts);
// live deps are shared with the reset route (metricsRouteDeps.ts).

import { handleMetrics } from '../../utils/metricsHandler'
import { liveMetricsDeps } from '../../utils/metricsRouteDeps'
import { bearerToken } from '../../utils/settingsHandler'

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const { status, body } = await handleMetrics(liveMetricsDeps(), { accessToken: token, domain })
  setResponseStatus(event, status)
  return body
})
