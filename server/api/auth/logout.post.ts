// POST /api/auth/logout — clear the operator session cookie. Requires the CSRF
// header (same reason as login). Always succeeds (idempotent).

import { CSRF_HEADER, SESSION_COOKIE } from '../../utils/session'

export default defineEventHandler((event) => {
  if (!getHeader(event, CSRF_HEADER)) {
    setResponseStatus(event, 403)
    return { error: 'missing csrf header' }
  }
  deleteCookie(event, SESSION_COOKIE, { path: '/' })
  return { ok: true }
})
