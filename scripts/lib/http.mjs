// Minimal HTTPS request helper shared by the bank sandbox demo scripts
// (alfa-oauth-test.mjs, prior-oauth-test.mjs). Standalone: no npm deps, so the
// scripts stay build-free (`node scripts/…`). Node >= 18.
//
// Security posture: this NEVER disables TLS verification. It honours the standard
// CA env vars (NODE_EXTRA_CA_CERTS) — a cert failure is a real finding to report,
// not something to paper over. The sandboxes are plain TLS; Priorbank prod needs
// BY-crypto TLS via the СКЗИ gateway, which is out of these scripts' scope.

import { request } from 'node:https'

/**
 * Perform one HTTPS request and buffer the response.
 * @param {string} urlStr absolute https URL
 * @param {{ method?: string, headers?: Record<string,string>, body?: string|Buffer, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number|undefined, headers: import('node:http').IncomingHttpHeaders, text: string, json?: any }>}
 */
export function httpRequest(urlStr, { method = 'GET', headers = {}, body, timeoutMs = 40000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers
      },
      (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          try {
            json = JSON.parse(text)
          } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`)))
    if (body) req.write(body)
    req.end()
  })
}
