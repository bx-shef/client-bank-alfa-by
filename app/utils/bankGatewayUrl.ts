// Address rules for the BY-crypto TLS gateway in front of Priorbank prod (#455, code half of #41).
//
// Пure — no I/O — so the rules are unit-tested and shared by the env readers and `envCheck`.
//
// WHY THIS EXISTS. `PRIOR_OAUTH_API_BASE` used to serve two roles at once:
//   1. the origin our BACKEND calls (token, consent, accounts, statements);
//   2. the origin the ADMIN'S BROWSER opens for the bank's authorize page.
// Point both at an internal crypto gateway and the authorize page stops loading — with no error on
// the server side at all, because the server never made that request. The connect flow just dies
// quietly. Hence a separate authorize origin, and the asymmetric scheme rules below.

/** Hosts that can only mean «inside our own deployment», so plain HTTP to them is legitimate. */
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true
  // Docker/compose service name: a single label with no dot (e.g. `avtunproxy`).
  if (!h.includes('.') && !h.includes(':')) return true
  // RFC 1918 / link-local — a private network address.
  return /^10\./.test(h)
    || /^192\.168\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /^169\.254\./.test(h)
}

/**
 * Validate the origin the BACKEND uses for Prior calls.
 *
 * `https://` is always fine. `http://` is accepted **only** for an internal host, because that is
 * exactly how the crypto gateway works: it accepts plain HTTP from us on an isolated network and
 * raises the BY-crypto TLS itself on the way out. Demanding `https` everywhere would forbid the
 * real deployment; allowing `http` anywhere would let a typo send the Bearer token (and, under
 * client_secret_basic, the client secret) across the open network in clear text.
 *
 * Returns the normalized origin (no trailing slash) or `null` when unusable.
 */
export function normalizeBankApiBase(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().replace(/\/+$/, '')
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol === 'https:') return value
  if (url.protocol === 'http:' && isInternalHost(url.hostname)) return value
  return null
}

/**
 * Validate the origin the ADMIN'S BROWSER opens (the bank's authorize page).
 *
 * Always `https://`, and never an internal host: this URL leaves our network entirely — we hand it
 * to a top-level browser navigation. An internal address here is the failure mode this module was
 * written for, so it is rejected rather than normalized.
 */
export function normalizeAuthorizeBase(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().replace(/\/+$/, '')
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (isInternalHost(url.hostname)) return null
  return value
}

/**
 * Do two configured URLs address the same origin? Used to warn when `PRIOR_OAUTH_API_BASE` and
 * `PRIOR_OAUTH_TOKEN_URL` drift apart: they are independent variables, so moving one onto the
 * gateway and forgetting the other leaves token refresh quietly pointed at the old host — the
 * import then stops with an ordinary-looking refresh failure.
 */
export function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  try {
    return new URL((a ?? '').trim()).origin === new URL((b ?? '').trim()).origin
  } catch {
    return false
  }
}
