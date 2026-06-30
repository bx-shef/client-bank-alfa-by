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
  B24EventDecision,
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

/**
 * Restore a nested object from B24's PHP bracket-encoded webhook body, e.g.
 * `event=ONAPPINSTALL&auth[member_id]=abc&data[VERSION]=1` →
 * `{ event: 'ONAPPINSTALL', auth: { member_id: 'abc' }, data: { VERSION: '1' } }`.
 * All leaf values are strings (form-encoding carries no types). Pure string→object,
 * so it stays portable; the backend feeds the result to `routeB24Event`.
 */
export function parseBracketForm(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of new URLSearchParams(raw)) {
    // "data[bot][id]" -> ["data", "bot", "id"]
    const path = key.replace(/\]/g, '').split('[')
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
  if (!auth.domain || !auth.member_id || !auth.application_token) {
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
 * after `installFinish`, so this is `Y` in practice — kept for an explicit gate. */
export function isInstallComplete(data: B24InstallEventData): boolean {
  return data.INSTALLED === undefined || data.INSTALLED === 'Y'
}

/** Whether the user asked to wipe the app's data on uninstall (`CLEAN == 1`).
 * Accepts the numeric `1` or the string `"1"` the form encoding produces. */
export function shouldPurgeData(data: B24UninstallEventData): boolean {
  return data.CLEAN === 1 || data.CLEAN === '1'
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

/** Loopback / private / link-local IPv4 ranges that a portal-supplied
 * `client_endpoint` must never resolve to (SSRF guard). */
const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/

/**
 * Whether `client_endpoint` (which arrives inside the event's auth, attacker-
 * influenceable) is safe to POST REST calls to: HTTPS only, and not pointing at
 * a loopback/private/link-local host. The backend calls this before using the
 * endpoint (bx-synapse's callPortal does the same). DNS-rebinding still needs a
 * runtime check — this guards the obvious literals.
 */
export function isSafeClientEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint || !/^https:\/\//i.test(endpoint)) return false
  let host: string
  try {
    host = new URL(endpoint).hostname
  } catch {
    return false
  }
  if (host === 'localhost' || host === '::1' || host === '[::1]') return false
  return !PRIVATE_IPV4.test(host)
}

/**
 * Pure routing + authenticity gate for one incoming B24 event POST. The backend
 * parses the request body (`parseBracketForm`), looks up the stored
 * application_token for the portal (by `member_id`), then calls this to learn
 * what to do:
 *
 *  - `install`   → persist `decision.credentials` (write-once application_token;
 *                  install carries OAuth data the engine validates separately).
 *  - `uninstall` → purge the portal iff `decision.purge`; gated on a token match,
 *                  the only authenticity signal here (no OAuth data is sent).
 *  - `unsupported` → an event we don't subscribe to; ignore (return 200).
 *
 * `opts.envToken` / `opts.storedToken` feed `appTokenVerdict`. Throws on a
 * non-`accept` verdict — a forged/stale/unconfigured call must not wipe data.
 * Backends needing distinct HTTP codes (403 vs 503) can call `appTokenVerdict`
 * directly instead of relying on the thrown message.
 */
export function routeB24Event(
  payload: unknown,
  opts: { envToken?: string, storedToken?: string } = {}
): B24EventDecision {
  const code = eventCode(payload)

  if (code === B24_EVENT_INSTALL) {
    const event = parseInstallEvent(payload)
    const verdict = appTokenVerdict({ isInstall: true, incoming: event.auth.application_token, envToken: opts.envToken })
    if (verdict !== 'accept') {
      throw new Error(`B24 ONAPPINSTALL: application_token rejected (${verdict})`)
    }
    return { kind: 'install', event, credentials: extractPortalCredentials(event) }
  }

  if (code === B24_EVENT_UNINSTALL) {
    const event = parseUninstallEvent(payload)
    const verdict = appTokenVerdict({
      isInstall: false,
      incoming: event.auth.application_token,
      envToken: opts.envToken,
      storedToken: opts.storedToken
    })
    if (verdict !== 'accept') {
      throw new Error(`B24 ONAPPUNINSTALL: application_token rejected (${verdict})`)
    }
    return { kind: 'uninstall', event, memberId: event.auth.member_id, purge: shouldPurgeData(event.data) }
  }

  return { kind: 'unsupported', code }
}
