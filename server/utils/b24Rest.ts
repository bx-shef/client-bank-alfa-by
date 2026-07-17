// Portal-host SSRF gate (#149). Every B24 REST call now goes through the jssdk transport
// (`b24Sdk.ts`): crm-sync uses a stored-token `B24OAuth`, the UI frame routes use
// `makeFrameRestCall`. Both build an outbound `https://<host>/rest/...` where `<host>` can be
// caller-supplied (the frame routes take it from an `X-B24-Domain` header). Without a host
// allow-list that is an outbound-request primitive (internal-host probing, self-token
// exfiltration to an attacker-chosen host). This module is the FAIL-CLOSED gate: `assertPortalHost`
// accepts only a cloud `*.bitrix24.<tld>` portal or an explicitly configured self-hosted host
// (env `B24_SELFHOSTED_HOSTS`) and returns the CLEAN parsed host; both transports route their
// domain through it before building a client, so the SDK's `clientEndpoint` can never point at a
// non-portal origin. Host extraction is via `URL` (not a regex) so a userinfo/port trick
// (`x.bitrix24.by@evil.com`) resolves to the REAL host — no parser-differential bypass. Pure +
// unit-tested; the raw `$fetch` `callRest` this module used to carry was retired with the jssdk
// migration.

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

/** Extract the bare lowercase hostname from a portal `host` (may arrive as a bare host,
 *  a full URL, or with a path). Parses via `URL` so a userinfo/port trick
 *  (`x.bitrix24.by@evil.com`, `host:1234`, `host/../x`) resolves to the REAL host, not
 *  the leading label — the same extraction the SDK client endpoint uses. Returns '' when it
 *  can't parse a host (→ fail-closed at the validator). */
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

// Self-hosted allow-list is static at runtime — parse the env once, lazily.
let selfHostedCache: Set<string> | null = null
function selfHostedHosts(): Set<string> {
  if (selfHostedCache === null) selfHostedCache = parseSelfHostedHosts(process.env.B24_SELFHOSTED_HOSTS)
  return selfHostedCache
}

/** SSRF gate as a single choke point (#149): validate a caller-supplied portal `host` against
 *  the allow-list (cloud zones + env self-hosted) and return the CLEAN lowercase hostname, or
 *  THROW when it isn't allowed. The jssdk frame-token client (`makeFrameRestCall`, b24Sdk.ts)
 *  routes its `X-B24-Domain` through this so the SDK's `clientEndpoint` can never be pointed at a
 *  non-portal host. Returning the clean host (not the raw input) is load-bearing: the SDK builds
 *  `https://<host>/rest/` from it, so passing the parsed host stops a `x.bitrix24.by@evil.com`
 *  userinfo trick from reaching a different origin. */
export function assertPortalHost(host: string): string {
  if (!isAllowedPortalHost(host, selfHostedHosts())) {
    throw new Error(`B24 REST refused — host not allow-listed: ${portalHostname(host) || '(unparseable)'}`)
  }
  return portalHostname(host)
}
