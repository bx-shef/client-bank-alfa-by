// GET /api/ops/queues — queue counts for the operator monitor (/queues page).
// Gated by the OPERATOR SESSION cookie (cba_sess), so a logged-in employee's
// browser can read it (unlike /api/queues, which needs the B24_APPLICATION_TOKEN
// and is nginx-denied). When auth is not configured (no password) the zone is open,
// matching the client route guard. Read-only GET — no CSRF header needed. Same
// payload shape as /api/queues. See docs/AUTH.md, docs/QUEUES.md.

import { SESSION_COOKIE, operatorAllowed, resolveAuthConfig } from '../../utils/session'
import { readQueueCounts } from '../../queue/stats'

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  if (!operatorAllowed(cfg, getCookie(event, SESSION_COOKIE), Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  return readQueueCounts()
})
