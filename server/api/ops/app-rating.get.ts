// GET /api/ops/app-rating — per-portal «оцените приложение» state for the owner /queues page, so the
// owner MANAGES the review lifecycle from the UI instead of running SQL. Operator SESSION cookie
// (same as GET /api/ops/queues). Returns NON-SECRET fields only (domain + timestamps).

import { SESSION_COOKIE, operatorAllowed, resolveAuthConfig } from '../../utils/session'
import { listRatingStatus } from '../../utils/appRatingStore'
import { buildRatingStatuses } from '../../utils/appRatingStatus'
import { dbQuery } from '../../db/client'

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  if (!operatorAllowed(cfg, getCookie(event, SESSION_COOKIE), Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  try {
    const rows = await listRatingStatus(dbQuery)
    return { portals: buildRatingStatuses(rows) }
  } catch {
    setResponseStatus(event, 502)
    return { error: 'rating status read failed' }
  }
})
