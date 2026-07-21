// Live wiring for the metrics endpoints (#78) — shared by GET /api/import/metrics and
// POST /api/import/metrics-reset so the two routes never drift. Binds the pure
// `MetricsDeps` (metricsHandler.ts) to Postgres + per-portal frame-token validation
// (`profile`), the same shape as import/status.get.ts's liveStatusDeps.

import type { MetricsDeps } from './metricsHandler'
import { frameRestCall } from './liveDeps'
import { getMemberIdByDomain } from './tokenStore'
import { readCounters, resetCounters } from './metricsStore'
import { dbQuery } from '../db/client'

export function liveMetricsDeps(): MetricsDeps {
  return {
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    validateFrame: async (domain, accessToken) => {
      // One `profile` call proves the token controls THIS portal (else B24 throws) and yields the
      // caller's id + ADMIN flag — the reset route gates on ADMIN (#182 parity).
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const result = res?.result as { ID?: unknown, ADMIN?: unknown } | undefined
      return { userId: result?.ID != null ? String(result.ID) : '', isAdmin: result?.ADMIN === true }
    },
    readCounters: memberId => readCounters(dbQuery, memberId),
    resetCounters: memberId => resetCounters(dbQuery, memberId)
  }
}
