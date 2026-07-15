// Thin Bitrix24 REST caller. `restUrl`, `b24ErrorMessage`, `portalHostname`,
// `parseSelfHostedHosts` and `isAllowedPortalHost` are pure (testable); `callRest`
// does the actual $fetch (Nitro global) and is injected into the pure settings
// handler, so business logic stays testable without the network.
//
// SSRF HARDENING (#149). The frame routes (`/api/settings`, `/api/chat-search`,
// `/api/import*`) take the portal `domain` from a caller-supplied `X-B24-Domain`
// header and build an outbound `https://<domain>/rest/...` POST whose body carries
// the caller's own `auth` token. Without a host allow-list that is an outbound-request
// primitive (internal-host probing, self-token exfiltration to an attacker-chosen host).
// So `callRest` is FAIL-CLOSED: the host must be a cloud `*.bitrix24.<tld>` portal or an
// explicitly configured self-hosted host (env `B24_SELFHOSTED_HOSTS`), else it throws
// before any network call. The validator and `restUrl` extract the host the SAME way
// (URL parsing, not a regex) so a userinfo/port trick (`x.bitrix24.by@evil.com`) cannot
// pass validation yet fetch a different host (no parser-differential bypass).

/** Cloud Bitrix24 portal host suffixes (`<name>.bitrix24.<tld>`). Every entry is a
 *  Bitrix-OWNED zone, so allow-listing it cannot enable SSRF (an attacker can't register
 *  a subdomain there). The LEADING DOT is load-bearing: it stops `evil-bitrix24.by` and
 *  `x.bitrix24.by.attacker.com` from matching. FAIL-CLOSED means an omitted zone silently
 *  refuses a legit portal, so completeness matters (CLAUDE.md: «портал может быть в любой
 *  стране»). Source: the official Bitrix24 DPA «Infrastructure and Sub-processors» (2025)
 *  regional zones (com/eu/de/it/pl/fr/uk/com.tr/com.br/es/mx/co/cn/in/id/jp/vn) + the
 *  1C-Bitrix (RU-operator) zones (ru/by/kz/ua) + `tech` (dev, as in b24Form). Keep in sync
 *  with the nginx CSP `frame-ancestors`/`connect-src` list. */
export const B24_CLOUD_HOST_SUFFIXES = [
  // 1C-Bitrix (RU operator) zones
  '.bitrix24.ru', '.bitrix24.by', '.bitrix24.kz', '.bitrix24.ua',
  // Bitrix24 international (DPA-listed) regional zones
  '.bitrix24.com', '.bitrix24.eu', '.bitrix24.de', '.bitrix24.fr',
  '.bitrix24.it', '.bitrix24.pl', '.bitrix24.es', '.bitrix24.uk',
  '.bitrix24.com.br', '.bitrix24.com.tr', '.bitrix24.mx', '.bitrix24.co',
  '.bitrix24.cn', '.bitrix24.in', '.bitrix24.id', '.bitrix24.jp',
  '.bitrix24.vn',
  // Dev/demo zone (matches app/utils/b24Form.ts)
  '.bitrix24.tech'
] as const

/** Outbound REST timeout (ms) — a portal that hangs must not tie up a worker/request
 *  slot indefinitely (same 15s budget as the OAuth token POST, #35). */
export const REST_TIMEOUT_MS = 15_000

/** Extract the bare lowercase hostname from a portal `host` (may arrive as a bare host,
 *  a full URL, or with a path). Parses via `URL` so a userinfo/port trick
 *  (`x.bitrix24.by@evil.com`, `host:1234`, `host/../x`) resolves to the REAL host, not
 *  the leading label — the same extraction the fetch URL uses. Returns '' when it can't
 *  parse a host (→ fail-closed at the validator). */
export function portalHostname(host: string): string {
  const raw = String(host ?? '').trim().replace(/^https?:\/\//i, '')
  if (!raw) return ''
  try {
    return new URL(`https://${raw}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Parse the env allow-list of self-hosted portal hosts (comma / space / newline
 *  separated) into a normalized Set of exact hostnames. Empty/undefined → empty set
 *  (cloud-only, the current deployment reality). Each token is normalized through
 *  `portalHostname` so `https://my.portal.tld/` and `my.portal.tld` both land as the
 *  bare host. */
export function parseSelfHostedHosts(raw: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const tok of String(raw ?? '').split(/[\s,]+/)) {
    const h = portalHostname(tok)
    if (h) out.add(h)
  }
  return out
}

/** True when `host` is an allowed portal: a cloud `*.bitrix24.<tld>` OR an exact
 *  self-hosted host from the env allow-list. FAIL-CLOSED — an empty/unparseable host is
 *  rejected. This is the SSRF gate (#149). Pure over the injected `selfHosted` set so it
 *  is unit-tested without env. */
export function isAllowedPortalHost(host: string, selfHosted: Set<string> = new Set()): boolean {
  const h = portalHostname(host)
  if (!h) return false
  if (B24_CLOUD_HOST_SUFFIXES.some(suffix => h.endsWith(suffix))) return true
  return selfHosted.has(h)
}

/** REST endpoint URL for a portal host + method (`x.bitrix24.by` + `app.option.get`).
 *  Uses `portalHostname` (same extraction as the validator) so the fetched host always
 *  equals the validated host — no parser-differential SSRF. FAIL-CLOSED on an empty host:
 *  `https:///rest/<method>` re-parses to host `<method's first label>`, a latent footgun
 *  for any caller that skips the gate — throw instead. (`callRest` already rejects such a
 *  host upstream, so this only hardens a hypothetical direct caller.) */
export function restUrl(host: string, method: string): string {
  const h = portalHostname(host)
  if (!h) throw new Error('b24Rest: invalid/empty portal host')
  return `https://${h}/rest/${method}`
}

/** A human-readable message if a REST body carries a Bitrix24 error, else null.
 *  B24 returns HTTP 200 with `{error, error_description}` for many failures (bad
 *  params, missing scope, rights) — so callers must inspect the body, not only the
 *  HTTP status. Used by `callRest` to fail loudly instead of returning an error
 *  body that downstream code would misread as an empty/absent result. */
export function b24ErrorMessage(resp: Record<string, unknown>): string | null {
  const err = resp?.error
  if (err === undefined || err === null || err === '') return null
  const desc = resp?.error_description
  return desc ? `${err}: ${desc}` : `${err}`
}

/** Typed B24 REST error carrying the machine-readable `error` code, so callers can
 *  distinguish `expired_token`/`invalid_token` (refresh + retry) from other failures.
 *  Extends Error and keeps the same human message `callRest` always threw, so any
 *  caller matching on `.message` is unaffected — only the extra `code` is new. */
export class B24RestError extends Error {
  constructor(readonly code: string, readonly description: string, message: string) {
    super(message)
    this.name = 'B24RestError'
  }
}

/** True when a REST error means the ACCESS token was rejected server-side and the call
 *  should be retried after a forced refresh (the token may be rejected before its computed
 *  expiry — clock skew / early server-side invalidation). Mirrors ai-price-import's
 *  reactive-retry classifier; here the resolver drives the retry (keeping our advisory-lock
 *  refresh, which that repo lacks). */
export function isExpiredTokenError(err: unknown): boolean {
  return err instanceof B24RestError && (err.code === 'expired_token' || err.code === 'invalid_token')
}

// Self-hosted allow-list is static at runtime — parse the env once, lazily.
let selfHostedCache: Set<string> | null = null
function selfHostedHosts(): Set<string> {
  if (selfHostedCache === null) selfHostedCache = parseSelfHostedHosts(process.env.B24_SELFHOSTED_HOSTS)
  return selfHostedCache
}

/** One-line REST-timing record (#78, «measure before you throttle» for #191): the
 *  method, total wall time, optional Bitrix server-side time (`time.duration`, lets you
 *  split network vs portal), and ok flag. Pure — the transport formats + logs it. `method`
 *  is a code literal (never payer/user input), so it needs no sanitization. */
export function restTimingLine(method: string, ms: number, ok: boolean, srvMs?: number): string {
  const srv = srvMs != null && Number.isFinite(srvMs) ? ` srv=${Math.round(srvMs)}` : ''
  return `[rest-timing] method=${method} ms=${Math.round(ms)}${srv} ok=${ok ? 1 : 0}`
}

/** Extract Bitrix's server-side processing time (ms) from a REST envelope's `time.duration`
 *  (seconds, float), or `undefined` when absent/non-finite. Pure. */
export function serverDurationMs(resp: Record<string, unknown>): number | undefined {
  const dur = (resp?.time as { duration?: unknown } | undefined)?.duration
  return typeof dur === 'number' && Number.isFinite(dur) ? dur * 1000 : undefined
}

// REST timing is opt-in (default OFF) — it logs one line per outbound call, which is
// noise in steady state but exactly what you want during a load test before adding the
// #191 rate limiter. Parsed once, lazily (env is static at runtime).
let restTimingCache: boolean | null = null
function restTimingEnabled(): boolean {
  if (restTimingCache === null) restTimingCache = /^(1|true|yes|on)$/i.test(String(process.env.REST_TIMING ?? '').trim())
  return restTimingCache
}

/** Call a REST method on the portal with an access token in the body. FAIL-CLOSED on a
 *  non-allow-listed host (#149 SSRF gate) and bounded by `REST_TIMEOUT_MS`. */
export async function callRest(
  host: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  // SSRF gate: reject a host that is not a cloud portal / configured self-hosted host
  // BEFORE any outbound request. `host` reaches here from a caller-supplied header on the
  // frame routes, so this is the boundary that turns an outbound-request primitive off.
  if (!isAllowedPortalHost(host, selfHostedHosts())) {
    throw new Error(`B24 REST ${method} refused — host not allow-listed: ${portalHostname(host) || '(unparseable)'}`)
  }
  // $fetch's route-typed overloads try to match a request URL against Nitro's
  // generated internal route table. With a dynamic (non-literal) URL that matching
  // recurses over every route and overflows the checker (TS2321) as the table grows.
  // This is a plain external POST to a portal host, so cast $fetch to a simple
  // signature to opt out of route inference (runtime behaviour is unchanged). The
  // reference stays inside the function so importing this module (e.g. for restUrl
  // in unit tests) doesn't touch the Nitro-only $fetch global.
  const fetchJson = $fetch as unknown as (
    url: string,
    opts: { method: string, body: Record<string, unknown>, timeout: number }
  ) => Promise<Record<string, unknown>>
  // Time the call for the opt-in [rest-timing] log (#78). A transport throw (network /
  // timeout) is logged as ok=0 before rethrowing; a 200 with a B24 {error} body logs ok=0
  // too (the error check below turns it into a throw).
  const timing = restTimingEnabled()
  const t0 = timing ? Date.now() : 0
  let json: Record<string, unknown>
  try {
    json = await fetchJson(restUrl(host, method), {
      method: 'POST',
      body: { ...params, auth: accessToken },
      // Bound the outbound call — a hung/slow portal must not pin a worker or request slot.
      timeout: REST_TIMEOUT_MS
    })
  } catch (e) {
    if (timing) console.log(restTimingLine(method, Date.now() - t0, false))
    throw e
  }
  // B24 signals many failures as HTTP 200 + {error} — surface them as throws so
  // callers (company lookup, activity write, settings) don't mistake an error body
  // for an empty result and silently swallow it.
  const err = b24ErrorMessage(json)
  if (timing) console.log(restTimingLine(method, Date.now() - t0, !err, serverDurationMs(json)))
  if (err) {
    // Carry the machine-readable `error` code so callers can detect `expired_token` and
    // refresh+retry. The message is unchanged, so `.message`-matching callers are unaffected.
    const code = json.error === undefined || json.error === null ? '' : String(json.error)
    const desc = json.error_description === undefined || json.error_description === null ? '' : String(json.error_description)
    throw new B24RestError(code, desc, `B24 REST ${method} failed — ${err}`)
  }
  return json
}
