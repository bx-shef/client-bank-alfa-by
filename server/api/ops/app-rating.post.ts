// POST /api/ops/app-rating { memberId, action } — owner control of the review lifecycle from the
// /queues page (manage, not SQL). Operator SESSION cookie + CSRF header (a state-changing op, same
// guard as /api/auth/logout). Actions:
//   'reviewed' → mark a confirmed Market review (terminal, stops prompting);
//   'reset'    → clear opened/prompted so the modal returns (no review appeared after verification).

import { CSRF_HEADER, SESSION_COOKIE, operatorAllowed, resolveAuthConfig } from '../../utils/session'
import { handleAppRatingOp } from '../../utils/appRatingOpsHandler'
import { clearOpened, markReviewed } from '../../utils/appRatingStore'
import { dbQuery } from '../../db/client'

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  if (!operatorAllowed(cfg, getCookie(event, SESSION_COOKIE), Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  if (!getHeader(event, CSRF_HEADER)) {
    setResponseStatus(event, 403)
    return { error: 'missing csrf header' }
  }
  const body = await readBody(event).catch(() => ({})) as { memberId?: unknown, action?: unknown }
  const res = await handleAppRatingOp(body?.memberId, body?.action, {
    markReviewed: id => markReviewed(id, dbQuery),
    reset: id => clearOpened(id, dbQuery)
  })
  setResponseStatus(event, res.status)
  return res.body
})
