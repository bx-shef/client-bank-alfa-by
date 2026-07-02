// POST /api/auth/login { user, password } — operator login (see docs/AUTH.md).
// 503 if no password is configured; 401 on bad credentials; on success sets the
// signed HttpOnly session cookie. Requires the CSRF header (a custom header can't
// be set by a cross-site form POST without a CORS preflight).

import { CSRF_HEADER, SESSION_COOKIE, checkCredentials, isAuthConfigured, resolveAuthConfig, signSession } from '../../utils/session'

function isSecure(event: Parameters<typeof getHeader>[0]): boolean {
  const proto = (getHeader(event, 'x-forwarded-proto') || getRequestProtocol(event) || '').split(',')[0]!.trim()
  return proto === 'https'
}

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  if (!isAuthConfigured(cfg)) {
    setResponseStatus(event, 503)
    return { error: 'auth not configured' }
  }
  if (!getHeader(event, CSRF_HEADER)) {
    setResponseStatus(event, 403)
    return { error: 'missing csrf header' }
  }
  let user: string
  let password: string
  try {
    const body = (await readBody(event)) as { user?: unknown, password?: unknown } | null
    user = String(body?.user ?? '')
    password = String(body?.password ?? '')
  } catch {
    setResponseStatus(event, 400)
    return { error: 'invalid body' }
  }
  if (!checkCredentials(user, password, cfg)) {
    setResponseStatus(event, 401)
    return { error: 'invalid credentials' }
  }
  const exp = Date.now() + cfg.ttlMs
  setCookie(event, SESSION_COOKIE, signSession({ sub: cfg.user, exp }, cfg.secret), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(event),
    path: '/',
    maxAge: Math.floor(cfg.ttlMs / 1000)
  })
  return { ok: true, user: cfg.user, exp }
})
