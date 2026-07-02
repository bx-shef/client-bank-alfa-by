// Post-login redirect guard for /login (see docs/AUTH.md). Only same-site
// relative paths are allowed; anything else falls back to /queues.
//
// The guard must be self-contained (not rely on navigateTo/ufo internals):
// besides protocol-relative `//host` it also rejects the backslash bypass
// `/\host` (and `/\t\host`, etc.), since WHATWG URL parsers normalize `\` to
// `/` for special schemes — so `/\host` is equivalent to `//host`.

/** Default landing page for authenticated operators. */
export const DEFAULT_REDIRECT = '/queues'

/**
 * Return a safe same-site path to redirect to after login, or DEFAULT_REDIRECT.
 * Accepts only a single leading `/` NOT followed by another `/` or `\`.
 */
export function safeRedirect(raw: unknown): string {
  const path = typeof raw === 'string' ? raw : DEFAULT_REDIRECT
  // Must start with exactly one `/` and the next char must not be `/` or `\`.
  return /^\/(?![/\\])/.test(path) ? path : DEFAULT_REDIRECT
}
