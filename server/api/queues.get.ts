// GET /api/queues — queue observability: per-queue job counts (waiting/active/
// completed/failed/…). Lets you see the pipeline moving right now without Grafana.
// Guarded by B24_APPLICATION_TOKEN (X-Check-Token header or ?token=), constant-time
// — same as app-option-check; nginx also denies it publicly. Deeper telemetry
// (Prometheus/Grafana or bull-board) is a documented follow-up (docs/REFACTOR_PLAN.md).

import { safeEqual } from '../../app/utils/b24Events'
import { getQueue, queueEnabled } from '../queue/connection'
import { QUEUE_NAMES } from '../queue/topology'

export default defineEventHandler(async (event) => {
  const expected = process.env.B24_APPLICATION_TOKEN?.trim() || ''
  const provided = (getHeader(event, 'x-check-token') || String(getQuery(event).token || '')).trim()
  if (!expected || !safeEqual(provided, expected)) {
    setResponseStatus(event, 403)
    return { error: 'forbidden' }
  }

  if (!queueEnabled()) return { enabled: false, queues: {} }

  const queues: Record<string, unknown> = {}
  for (const name of QUEUE_NAMES) {
    queues[name] = await getQueue(name).getJobCounts()
  }
  return { enabled: true, queues }
})
