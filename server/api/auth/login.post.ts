// POST /api/auth/login { user, password } — operator login (see docs/AUTH.md).
// Thin handler: reads the CSRF header + body, delegates the status matrix to the
// pure `decideLogin` (503/403/400/401/200), and on success sets the signed
// HttpOnly session cookie. The CSRF header can't be set by a cross-site form POST
// without a CORS preflight.

import { CSRF_HEADER, decideLogin, resolveAuthConfig } from '../../utils/session'

function isSecure(event: Parameters<typeof getHeader>[0]): boolean {
  const proto = (getHeader(event, 'x-forwarded-proto') || getRequestProtocol(event) || '').split(',')[0]!.trim()
  return proto === 'https'
}

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  const hasCsrf = Boolean(getHeader(event, CSRF_HEADER))
  // Parse the body up front; `null` = unparseable → decideLogin maps it to 400,
  // but only after the config/CSRF checks (so precedence is unchanged).
  let creds: { user: string, password: string } | null
  try {
    const body = (await readBody(event)) as { user?: unknown, password?: unknown } | null
    creds = { user: String(body?.user ?? ''), password: String(body?.password ?? '') }
  } catch {
    creds = null
  }

  const decision = decideLogin(cfg, hasCsrf, creds, Date.now())
  if (decision.status === 200) {
    setCookie(event, decision.cookie.name, decision.cookie.value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure(event),
      path: '/',
      maxAge: decision.cookie.maxAgeSec
    })
    return decision.body
  }
  setResponseStatus(event, decision.status)
  return decision.body
})
