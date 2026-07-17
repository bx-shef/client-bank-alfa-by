// GET /api/ready — public READINESS probe (closes the OPERATIONS.md liveness gap; queue-depth
// telemetry is the separate #78 follow-up). Unlike /api/health (process liveness only,
// which stays green even when Postgres/Redis are down — see docs/OPERATIONS.md), this actually
// PROBES the backend's hard dependencies: a Postgres `SELECT 1` and, when queues are enabled,
// a Redis PING. Returns 200 `{ready:true,…}` when the app can actually work, else 503
// `{ready:false,…}` so an uptime monitor / on-call responder can tell "process up" from "app
// unable to serve". Booleans only — NO secrets, NO queue depth (that's token-gated /api/queues).
// Reachable at https://<domain>/api/ready (nginx proxies /api/* to the backend).

import { evaluateReadiness } from '../utils/readiness'
import { dbQuery } from '../db/client'
import { pingRedis, queueEnabled } from '../queue/connection'

export default defineEventHandler(async (event) => {
  const result = await evaluateReadiness({
    checkDb: async () => {
      await dbQuery('SELECT 1')
      return true
    },
    redisConfigured: queueEnabled,
    pingRedis
  })
  setResponseStatus(event, result.ready ? 200 : 503)
  return result
})
