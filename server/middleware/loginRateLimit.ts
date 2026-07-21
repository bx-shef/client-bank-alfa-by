// Nitro request middleware: throttles POST /api/auth/login by client IP — the brute-force
// backstop for the shared operator password on the no-nginx deploy (Vibecode Black Hole). Must
// run BEFORE the route handler (to reject early), so it lives in middleware, not the response
// plugin. Gated by `SECURITY_HEADERS_ENABLED`: set only by the Black Hole deploy; behind nginx
// the flag is unset and this is a no-op (nginx's `login` limit_req zone throttles instead, #64).
// Security HEADERS are set separately in server/plugins/securityHeaders.ts (they must also reach
// prerendered static pages, which middleware doesn't cover). Pure core: loginRateLimit.ts (tested).

import { securityHeadersEnabled } from '../utils/securityHeaders'
import { clientIpKey, createRateLimiter } from '../utils/loginRateLimit'

// One shared limiter for this process (Black Hole is single-process): ~10 attempts / minute per
// client IP, mirroring the nginx `login` zone rate (#64). Module scope so it persists across
// requests.
const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 10 })

export default defineEventHandler((event) => {
  if (!securityHeadersEnabled()) return
  if (event.method !== 'POST' || event.path.split('?')[0] !== '/api/auth/login') return

  const key = clientIpKey(getHeader(event, 'x-forwarded-for'), event.node.req.socket?.remoteAddress)
  const decision = loginLimiter.check(key, Date.now())
  if (!decision.allowed) {
    setResponseHeader(event, 'Retry-After', decision.retryAfterSec)
    throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' })
  }
})
