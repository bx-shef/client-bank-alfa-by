// GET /api/queues — queue observability for console/diagnostics: per-queue job
// counts (waiting/active/completed/…). Guarded by B24_APPLICATION_TOKEN via the
// `X-Check-Token` HEADER only (constant-time) — no `?token=` query fallback, which
// would leak the token into access logs / browser history. scripts/queue-stats.sh
// uses the header. nginx also denies it publicly. The operator/browser path is the
// session-gated GET /api/ops/queues. Deeper telemetry (Prometheus/Grafana) — #78.

import { checkQueueToken, readQueueCounts } from '../queue/stats'

export default defineEventHandler(async (event) => {
  const expected = process.env.B24_APPLICATION_TOKEN?.trim() || ''
  const provided = (getHeader(event, 'x-check-token') || '').trim()
  if (!checkQueueToken(expected, provided)) {
    setResponseStatus(event, 403)
    return { error: 'forbidden' }
  }
  return readQueueCounts()
})
