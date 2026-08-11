// Address rules for the BY-crypto TLS gateway in front of Priorbank prod (#455, code half of #41).
//
// Pure — no I/O — so the rules are unit-tested and shared by the env readers that build a BANK
// BASE URL (`priorConnectConfigFromEnv`, `priorApiBaseFromEnv`, `bankApiConfig`, `bankCredsFromEnv`)
// plus `envCheck`. Deliberately NOT applied to `*_AUDIENCE` (a JWT claim, not an address) or to the
// `*_REDIRECT_URI` values (the bank compares those byte-for-byte — normalizing would break it).
// The full map lives in docs/PRIOR_API.md «СКЗИ».
//
// WHY THIS EXISTS. `PRIOR_OAUTH_API_BASE` used to serve two roles at once:
//   1. the origin our BACKEND calls (token, consent, accounts, statements);
//   2. the origin the ADMIN'S BROWSER opens for the bank's authorize page.
// Point both at an internal crypto gateway and the authorize page stops loading — with no error on
// the server side at all, because the server never made that request. The connect flow just dies
// quietly. Hence a separate authorize origin, and the asymmetric scheme rules below.

/** Dotted-quad IPv4 — the ONLY shape `URL.hostname` yields for a real IPv4 literal (the parser
 *  canonicalizes decimal/octal/hex forms like `2130706433` or `0x7f000001` before we see them).
 *  A public FQDN never has an all-numeric last label, so this also separates `10.0.0.5` from the
 *  perfectly ordinary domain `10.attacker.com`. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Hosts that can only mean «inside our own deployment», so plain HTTP to them is legitimate.
 *
 * ⚠ Anchoring matters. An unanchored `/^10\./` also matches `10.attacker.com` — a normal public
 * domain whose first label happens to be `10`, with an A record its owner fully controls. That
 * would turn «http only to an internal host» into «http to anywhere», i.e. the Bearer token (and
 * the client secret under client_secret_basic) in clear text. Hence: parse the host as an IPv4
 * literal FIRST, then compare octets — never prefix-match a hostname.
 */
function isInternalHost(host: string): boolean {
  // A trailing dot is a legal FQDN root (`localhost.` resolves exactly like `localhost`), so strip
  // it before any comparison — otherwise it is a one-character bypass of every check below.
  const h = host.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost') return true

  // IPv6 literals arrive bracketed and already canonicalized by the URL parser.
  if (h.startsWith('[') && h.endsWith(']')) {
    const v6 = h.slice(1, -1)
    if (v6 === '::1' || v6 === '::') return true
    // IPv4-mapped (`::ffff:7f00:1`) — the parser compresses the embedded IPv4 to hex, so the
    // decision has to be made on the prefix rather than on a readable dotted form.
    if (v6.startsWith('::ffff:')) return true
    // ULA fc00::/7 and link-local fe80::/10 — private by definition.
    if (/^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6)) return true
    return false
  }

  const m = IPV4.exec(h)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127) return true // loopback /8
    if (a === 0) return true // 0.0.0.0 — «this host»
    if (a === 10) return true // RFC 1918
    if (a === 192 && b === 168) return true // RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true // RFC 1918
    if (a === 169 && b === 254) return true // link-local
    return false
  }

  // Docker/compose service name: a single label with no dot (e.g. `avtunproxy`).
  return !h.includes('.') && !h.includes(':')
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
