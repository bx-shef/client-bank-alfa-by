// Pure handlers for Bitrix24 outgoing event webhooks: ONAPPINSTALL and
// ONAPPUNINSTALL. No I/O — parses/validates the event envelope, extracts the
// per-portal credentials to persist, authenticates the call via
// application_token, and decides what the backend should do (store / purge /
// ignore). The HTTP transport, the token store and the side effects live in the
// engine (backend); these helpers are unit-testable offline and portable.
//
// Authenticity (B24 "Безопасность в обработчиках"): every event POST carries
// `auth.application_token`. It is first seen on ONAPPINSTALL, alongside OAuth
// data, and must be persisted (per portal, keyed by member_id). Later events —
// crucially ONAPPUNINSTALL, which carries no OAuth data — are trusted only when
// their application_token matches the stored (or env-configured) one. That
// constant-time compare is the sole authenticity signal for uninstall.
//
// Shape modelled on the bx-synapse backend (a working B24 integration): the wire
// format is `application/x-www-form-urlencoded` with PHP brackets
// (`auth[member_id]=…`), so the backend pipes the raw body through
// `parseBracketForm` before `routeB24Event`. The JSON examples in the REST docs
// are the same nested shape these functions consume.

import type {
  B24Event,
  B24EventAuth,
  B24InstallEvent,
  B24InstallEventData,
  B24UninstallEvent,
  B24UninstallEventData,
  PortalCredentials
} from '~/types/b24Events'

/** Event code B24 sends right after a successful install (carries OAuth + token). */
export const B24_EVENT_INSTALL = 'ONAPPINSTALL'
/** Event code B24 sends on uninstall (no OAuth data — token-only authenticity). */
export const B24_EVENT_UNINSTALL = 'ONAPPUNINSTALL'

/** Verdict of the event-broker authenticity gate (see appTokenVerdict). */
export type B24AppTokenVerdict = 'accept' | 'forbidden' | 'unconfigured'

/** Keys that must never be written through bracket paths — they would let an
 * attacker poison `Object.prototype` via the untrusted webhook body. */
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Restore a nested object from B24's PHP bracket-encoded webhook body, e.g.
 * `event=ONAPPINSTALL&auth[member_id]=abc&data[VERSION]=1` →
 * `{ event: 'ONAPPINSTALL', auth: { member_id: 'abc' }, data: { VERSION: '1' } }`.
 * All leaf values are strings (form-encoding carries no types). Pure string→object,
 * so it stays portable; the backend feeds the result to `routeB24Event`.
 *
 * The body is untrusted (the webhook URL is public; application_token is verified
 * only after parsing), so keys touching `__proto__`/`constructor`/`prototype` are
 * dropped to prevent prototype pollution.
 */
export function parseBracketForm(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of new URLSearchParams(raw)) {
    // "data[bot][id]" -> ["data", "bot", "id"]
    const path = key.replace(/\]/g, '').split('[')
    if (path.some(seg => POLLUTING_KEYS.has(seg))) continue
    let node: Record<string, unknown> = out
    for (let i = 0; i < path.length; i++) {
      const seg = path[i] as string
      if (i === path.length - 1) {
        node[seg] = value
        break
      }
      if (typeof node[seg] !== 'object' || node[seg] === null) {
        node[seg] = {}
      }
      node = node[seg] as Record<string, unknown>
    }
  }
  return out
}

/** Read the event code from a payload, upper-cased (`OnAppInstall` →
 * `ONAPPINSTALL`) so routing is case-insensitive. Empty string if absent. */
export function eventCode(payload: unknown): string {
  const code = (payload as { event?: unknown } | null)?.event
  return typeof code === 'string' ? code.toUpperCase() : ''
}

/**
 * Constant-time string compare. Avoids leaking how many leading characters of a
 * secret matched via early-exit timing. Pure JS (no node:crypto) so it stays
 * portable to any runtime; the backend may swap in `crypto.timingSafeEqual`.
 * Unequal lengths still walk the longer string to keep timing length-only.
 */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

/**
 * Whether an incoming event's application_token authenticates it against the
 * one stored at install time. False if either side is empty (an unknown portal,
 * or a payload with no token, is never trusted). Constant-time.
 */
export function verifyApplicationToken(received: string | undefined, stored: string | undefined): boolean {
  if (!received || !stored) return false
  return safeEqual(received, stored)
}

/**
 * Fail-closed authenticity gate for the event broker (mirrors bx-synapse).
 * The expected token may come from env (`B24_APPLICATION_TOKEN`, set once the
 * app is registered) or from the per-portal value stored at install time.
 *
 *  - On install: env token, if configured, is enforced; otherwise the first
 *    non-empty incoming token bootstraps trust (an empty one is a probe → reject).
 *  - On other events: an expected token (env or stored) is required —
 *    `unconfigured` when neither exists (portal unknown / not installed), so the
 *    caller fails closed (e.g. HTTP 503) instead of trusting the call.
 *
 * The backend maps the verdict to a response: `accept` → handle, `forbidden`
 * → 403, `unconfigured` → 503.
 */
export function appTokenVerdict(opts: {
  isInstall: boolean
  incoming: string
  envToken?: string
  storedToken?: string
}): B24AppTokenVerdict {
  const { isInstall, incoming } = opts
  const envToken = opts.envToken ?? ''
  const storedToken = opts.storedToken ?? ''

  if (isInstall) {
    if (envToken) return safeEqual(incoming, envToken) ? 'accept' : 'forbidden'
    // Bootstrap without env: accept the install but reject an empty token.
    return incoming ? 'accept' : 'forbidden'
  }

  const expected = envToken || storedToken
  if (!expected) return 'unconfigured'
  return safeEqual(incoming, expected) ? 'accept' : 'forbidden'
}

/** Validate and return the `auth` block, asserting the fields every event has
 * (domain, member_id, application_token). Throws on a malformed payload. */
function parseEventAuth(payload: unknown): B24EventAuth {
  const auth = (payload as { auth?: unknown } | null)?.auth as B24EventAuth | undefined
  if (!auth || typeof auth !== 'object') {
    throw new Error('B24 event: missing auth block')
  }
  // Require non-empty strings: a bracket-parsed body could put an object on a
  // field (`auth[domain][x]=1`), which a bare truthiness check would let through.
  if (typeof auth.domain !== 'string' || !auth.domain
    || typeof auth.member_id !== 'string' || !auth.member_id
    || typeof auth.application_token !== 'string' || !auth.application_token) {
    throw new Error('B24 event: auth is missing domain/member_id/application_token')
  }
  return auth
}

/** Parse + validate an ONAPPINSTALL payload. Throws if the code or required
 * `data`/`auth` fields are missing. */
export function parseInstallEvent(payload: unknown): B24InstallEvent {
  if (eventCode(payload) !== B24_EVENT_INSTALL) {
    throw new Error(`B24 event: expected ${B24_EVENT_INSTALL}, got "${eventCode(payload)}"`)
  }
  const auth = parseEventAuth(payload)
  const data = (payload as { data?: unknown }).data as B24InstallEventData | undefined
  if (!data || !data.VERSION) {
    throw new Error('B24 ONAPPINSTALL: missing data.VERSION')
  }
  return { ...(payload as B24Event<B24InstallEventData>), auth, data }
}

/** Parse + validate an ONAPPUNINSTALL payload. Throws if the code or required
 * `auth` fields are missing. `data` is optional (uninstall may omit it). */
export function parseUninstallEvent(payload: unknown): B24UninstallEvent {
  if (eventCode(payload) !== B24_EVENT_UNINSTALL) {
    throw new Error(`B24 event: expected ${B24_EVENT_UNINSTALL}, got "${eventCode(payload)}"`)
  }
  const auth = parseEventAuth(payload)
  const data = ((payload as { data?: unknown }).data ?? {}) as B24UninstallEventData
  return { ...(payload as B24Event<B24UninstallEventData>), auth, data }
}

/** Whether the install is fully finished (`INSTALLED === 'Y'`). Events fire only
 * after `installFinish`, so this is `Y` in practice. Not wired into
 * `routeB24Event` — it's an optional gate the backend may apply (e.g. skip a
 * half-installed portal) before acting on the credentials. */
export function isInstallComplete(data: B24InstallEventData): boolean {
  return data.INSTALLED === undefined || data.INSTALLED === 'Y'
}

/**
 * Map an install event's auth block to the credentials the backend persists,
 * keyed by `memberId`. `issuedAtMs` is intentionally not set here — the engine
 * stamps it with `Date.now()` when it actually receives the tokens (same rule as
 * alfaOauth: the timestamp must be the receipt time, not parse time). The
 * caller must store `applicationToken` write-once: the first legitimate install
 * sets it, later events must not overwrite it (bx-synapse uses COALESCE/NULLIF).
 */
export function extractPortalCredentials(event: B24InstallEvent): PortalCredentials {
  const a = event.auth
  return {
    memberId: a.member_id,
    domain: a.domain,
    applicationToken: a.application_token,
    ...(a.client_endpoint ? { clientEndpoint: a.client_endpoint } : {}),
    ...(a.server_endpoint ? { serverEndpoint: a.server_endpoint } : {}),
    ...(a.access_token ? { accessToken: a.access_token } : {}),
    ...(a.refresh_token ? { refreshToken: a.refresh_token } : {}),
    ...(a.expires_in !== undefined ? { expiresIn: a.expires_in } : {}),
    ...(a.scope ? { scope: a.scope } : {})
  }
}

/** Loopback / "this network" / private / link-local IPv4 ranges that a
 * portal-supplied `client_endpoint` must never resolve to (SSRF guard).
 * `0.` (0.0.0.0/8) is reserved and on many OSes routes to loopback. */
const PRIVATE_IPV4 = /^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/

/**
 * Whether `client_endpoint` (which arrives inside the event's auth, attacker-
 * influenceable) is safe to POST REST calls to: HTTPS only, and not pointing at
 * a loopback/private/link-local host. Covers IPv4 (incl. octal/decimal forms,
 * normalized by WHATWG `URL`) and IPv6 — loopback `::1`/unspecified `::`, ULA
 * `fc00::/7`, link-local `fe80::/10`, and IPv4-mapped `::ffff:a.b.c.d` (the
 * embedded IPv4 is re-checked). The backend calls this before using the endpoint
 * (bx-synapse's callPortal does the same). DNS-rebinding still needs a runtime
 * check — this guards the literal forms.
 */
export function isSafeClientEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint || !/^https:\/\//i.test(endpoint)) return false
  let host: string
  try {
    host = new URL(endpoint).hostname
  } catch {
    return false
  }
  // WHATWG URL keeps IPv6 hosts bracketed (`[::1]`) — strip for matching.
  const h = (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host).toLowerCase()
  if (h === 'localhost') return false

  if (h.includes(':')) {
    if (h === '::1' || h === '::') return false
    if (h.startsWith('::ffff:')) return false // IPv4-mapped IPv6 (URL folds the IPv4 into hex)
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return false // fc00::/7 (unique local)
    if (/^fe[89ab][0-9a-f]:/.test(h)) return false // fe80::/10 (link-local)
    return true
  }
  return !PRIVATE_IPV4.test(h)
}

// NOTE: routing + authenticity for a real incoming event lives in the backend
// handler `server/utils/b24EventsHandler.ts` (`processB24Event`), which returns an
// `action` the route enqueues. An earlier pure `routeB24Event` router was removed —
// it duplicated that logic and encoded the old CLEAN-conditional purge, which the
// always-purge policy overturned (see docs/B24_EVENTS.md).
