// Nitro plugin: stamps baseline security headers on EVERY response — including PRERENDERED
// static pages (/, /import, …), which `server/middleware/` does NOT cover (the static-asset
// handler serves them without running request middleware, and CSP is document-scoped, so it
// MUST reach the HTML). The `beforeResponse` hook fires for static serves too, so headers land
// on both the landing and the API. Gated by `SECURITY_HEADERS_ENABLED` — set only by the no-nginx
// Vibecode Black Hole deploy (docs/DEPLOY_VIBECODE.md); behind nginx the flag is unset and this is
// a no-op (nginx owns the headers). Pure builder: server/utils/securityHeaders.ts (unit-tested).

import { buildSecurityHeaders, securityHeadersEnabled } from '../utils/securityHeaders'

function isHttps(event: Parameters<typeof getHeader>[0]): boolean {
  const proto = (getHeader(event, 'x-forwarded-proto') || getRequestProtocol(event) || '').split(',')[0]!.trim()
  return proto === 'https'
}

export default defineNitroPlugin((nitroApp) => {
  if (!securityHeadersEnabled()) return // nginx path (default): no-op

  nitroApp.hooks.hook('beforeResponse', (event) => {
    // Don't clobber a header an inner handler set deliberately (e.g. the form-scoped CSP for
    // b24-form.html, if that ever runs through here) — only add ours when absent.
    const headers = buildSecurityHeaders({ https: isHttps(event) })
    for (const [name, value] of Object.entries(headers)) {
      if (!getResponseHeader(event, name)) setResponseHeader(event, name, value)
    }
  })
})
