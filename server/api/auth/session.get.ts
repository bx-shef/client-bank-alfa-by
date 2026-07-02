// GET /api/auth/session — current session status for the client guard.
// `configured:false` means login is disabled (no password set) → the UI treats
// gated pages as open. Safe GET; the status matrix is the pure `sessionStatus`.

import { SESSION_COOKIE, resolveAuthConfig, sessionStatus } from '../../utils/session'

export default defineEventHandler((event) => {
  const cfg = resolveAuthConfig(process.env)
  return sessionStatus(cfg, getCookie(event, SESSION_COOKIE), Date.now())
})
