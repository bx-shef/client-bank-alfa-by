// Nitro startup plugin: warn (non-secret) about a risky operator-auth env.
// In production, log a clear warning when the operator zone is left open (no
// password) or when the HMAC key falls back to being derived from the password
// (no SESSION_SECRET). Never crashes and never logs secrets — see docs/AUTH.md.

import { authStartupWarning } from '../utils/session'

export default defineNitroPlugin(() => {
  const warning = authStartupWarning(process.env)
  if (warning) console.warn(`[auth] ${warning}`)
})
