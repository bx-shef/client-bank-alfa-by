// GET /api/ready — public READINESS probe (closes the OPERATIONS.md liveness gap; queue-depth
// telemetry is the separate #78 follow-up). Unlike /api/health (process liveness only,
// which stays green even when Postgres/Redis are down — see docs/OPERATIONS.md), this actually
// PROBES the backend's hard dependencies: a Postgres `SELECT 1` and, when queues are enabled,
// a Redis PING. Returns 200 `{ready:true,…}` when the app can actually work, else 503
// `{ready:false,…}` so an uptime monitor / on-call responder can tell "process up" from "app
// unable to serve". Booleans only — NO secrets, NO queue depth (that's token-gated /api/queues).
// Reachable at https://<domain>/api/ready (nginx proxies /api/* to the backend).

import { evaluateReadiness, gatewayProbeBase } from '../utils/readiness'
import { dbQuery } from '../db/client'
import { pingRedis, queueEnabled } from '../queue/connection'
import { priorApiBaseFromEnv } from '../utils/priorFetch'
import { normalizeBankApiBase } from '../../app/utils/bankGatewayUrl'

/** Timeout for the gateway probe. Short on purpose: this endpoint is what an on-call responder
 *  hits when something is already wrong, and it must answer even when the gateway is wedged. */
const GW_PROBE_TIMEOUT_MS = 2000

export default defineEventHandler(async (event) => {
  // Which address (if any) means "traffic goes through the gateway" — pure, and tested as such
  // in tests/readiness.test.ts; here we only read the env it decides over.
  const gwBase = gatewayProbeBase(
    priorApiBaseFromEnv(),
    normalizeBankApiBase(process.env.PRIOR_OAUTH_TOKEN_URL)
  )
  const viaGateway = gwBase !== null

  const result = await evaluateReadiness({
    checkDb: async () => {
      await dbQuery('SELECT 1')
      return true
    },
    redisConfigured: queueEnabled,
    pingRedis,
    cryptoGwConfigured: () => viaGateway,
    pingCryptoGw: async () => {
      // The gateway's OWN /healthz — never a bank endpoint. Probing the bank from here would
      // report their outage as ours and would spend a request from their budget on every poll
      // of this URL.
      await $fetch(`${gwBase}/healthz`, { timeout: GW_PROBE_TIMEOUT_MS, retry: 0 })
      return true
    }
  })
  setResponseStatus(event, result.ready ? 200 : 503)
  return result
})
