// Baseline HTTP security headers for the deploy paths that DON'T sit behind our nginx
// (the Vibecode Black Hole single-Nitro process — docs/DEPLOY_VIBECODE.md). In the main
// prod path nginx sets these (nginx.conf), so this is INERT there: the middleware only
// runs when `SECURITY_HEADERS_ENABLED` is set, which only the Black Hole deploy does — the
// nginx path is byte-identical (default OFF). Pure builders (no H3/event), unit-tested.
//
// ⚠ The CSP here is WEAKER than the nginx one: nginx computes per-build sha256 hashes for the
// two inline scripts (theme-init + __NUXT__.config) via scripts/csp-hashes.mjs and ships a CSP
// with NO `unsafe-inline`. The Black Hole build has no such hash step, so script-src falls back
// to `'unsafe-inline'`. Everything else (object-src 'none', base-uri 'self', a strict
// connect-src / frame-ancestors / frame-src allowlist) still applies — meaningfully better than
// no CSP, but the hash-based script-src remains an nginx-only strength (documented tradeoff).

/** Bitrix24 cloud TLD hosts the app must interoperate with (iframe embedding + REST fetch).
 *  Mirrors the allowlist in nginx.conf's `frame-ancestors`/`connect-src`. */
export const B24_CSP_HOSTS = [
  'https://*.bitrix24.ru', 'https://*.bitrix24.by', 'https://*.bitrix24.com',
  'https://*.bitrix24.eu', 'https://*.bitrix24.kz', 'https://*.bitrix24.ua',
  'https://*.bitrix24.de', 'https://*.bitrix24.fr', 'https://*.bitrix24.it',
  'https://*.bitrix24.pl', 'https://*.bitrix24.es', 'https://*.bitrix24.uk',
  'https://*.bitrix24.com.br', 'https://*.bitrix24.com.tr', 'https://*.bitrix24.mx',
  'https://*.bitrix24.co', 'https://*.bitrix24.cn', 'https://*.bitrix24.in',
  'https://*.bitrix24.id', 'https://*.bitrix24.jp', 'https://*.bitrix24.vn',
  'https://*.bitrix24.tech'
] as const

/** Yandex.Metrika origins the landing snippet talks to (same as nginx). */
const YANDEX_HOSTS = ['https://mc.yandex.ru', 'https://mc.yandex.com'] as const

/** Whether the in-Nitro security headers are enabled (the no-nginx deploy sets this). Default
 *  OFF so the nginx prod path never double-sets headers. Any value other than '' / '0' enables. */
export function securityHeadersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SECURITY_HEADERS_ENABLED ?? '').trim()
  return v !== '' && v !== '0'
}

/** Build the Content-Security-Policy value for the no-nginx deploy (see file header for why the
 *  script-src uses `'unsafe-inline'` here instead of nginx's per-build hashes). */
export function buildContentSecurityPolicy(): string {
  const b24 = B24_CSP_HOSTS.join(' ')
  const ya = YANDEX_HOSTS.join(' ')
  return [
    'default-src \'self\'',
    // Inline scripts (theme-init + __NUXT__.config) — no hash pipeline off-nginx, so 'unsafe-inline'.
    `script-src 'self' 'unsafe-inline' ${YANDEX_HOSTS[0]}`,
    'style-src \'self\' \'unsafe-inline\'',
    `img-src 'self' data: ${YANDEX_HOSTS[0]}`,
    `connect-src 'self' ${ya} ${b24}`,
    'font-src \'self\' data:',
    'object-src \'none\'',
    `frame-src 'self' ${YANDEX_HOSTS[0]}`,
    // Who may embed us: self + Bitrix24 portals (in-portal iframe).
    `frame-ancestors 'self' ${b24}`,
    'base-uri \'self\''
  ].join('; ')
}

/** Build the full baseline security-header set. HSTS is emitted only over HTTPS (an HSTS header
 *  on a plain-HTTP response is ignored by browsers and pointless). X-Frame-Options is OMITTED on
 *  purpose — it can't express the Bitrix24 embedding allowlist; CSP `frame-ancestors` does. */
export function buildSecurityHeaders(opts: { https: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), interest-cohort=()',
    'Content-Security-Policy': buildContentSecurityPolicy()
  }
  if (opts.https) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  return headers
}
