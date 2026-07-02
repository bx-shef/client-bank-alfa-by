// GET /api/auth/session — current session status for the client guard.
// `configured:false` means login is disabled (no password set) → the UI treats
// gated pages as open. Safe GET; reads only the signed cookie.

import { SESSION_COOKIE, isAuthConfigured, resolveAuthConfig, verifySession } from '../../utils/session'

export default defineEventHandler((event) => {
  const cfg = resolveAuthConfig(process.env)
  const payload = verifySession(getCookie(event, SESSION_COOKIE), cfg.secret, Date.now())
  return {
    configured: isAuthConfigured(cfg),
    authenticated: Boolean(payload),
    ...(payload ? { user: payload.sub } : {})
  }
})
