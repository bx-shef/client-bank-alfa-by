// POST /api/auth/logout — clear the operator session cookie. Requires the CSRF
// header (same reason as login); the status matrix is the pure `decideLogout`.
// Idempotent (always succeeds when the header is present).

import { CSRF_HEADER, SESSION_COOKIE, decideLogout } from '../../utils/session'

export default defineEventHandler((event) => {
  const decision = decideLogout(Boolean(getHeader(event, CSRF_HEADER)))
  if (decision.status === 200) {
    deleteCookie(event, SESSION_COOKIE, { path: '/' })
    return decision.body
  }
  setResponseStatus(event, decision.status)
  return decision.body
})
