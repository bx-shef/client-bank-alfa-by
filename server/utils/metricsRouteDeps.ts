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
      const res = await frameRestCall(domain, accessToken, 'profile', {})
      const id = (res?.result as { ID?: unknown } | undefined)?.ID
      return id != null ? String(id) : ''
    },
    readCounters: memberId => readCounters(dbQuery, memberId),
    resetCounters: memberId => resetCounters(dbQuery, memberId)
  }
}
