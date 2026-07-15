// POST /api/import/metrics-reset — clear the portal's lifetime counters (#78), the
// operator's «сбросить метрики». Auth = the B24 frame token (Authorization: Bearer) +
// X-B24-Domain, member-scoped (a portal only ever resets its own counters). Thin I/O
// over the pure handler; live deps are shared with the read route (metricsRouteDeps.ts).

import { handleMetricsReset } from '../../utils/metricsHandler'
import { liveMetricsDeps } from '../../utils/metricsRouteDeps'
import { bearerToken } from '../../utils/settingsHandler'

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const { status, body } = await handleMetricsReset(liveMetricsDeps(), { accessToken: token, domain })
  setResponseStatus(event, status)
  return body
})
