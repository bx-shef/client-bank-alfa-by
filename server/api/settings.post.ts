// POST /api/settings { value } — write the app-level test setting for the
// CALLER'S OWN portal. Auth = Bitrix24 frame access token (Authorization: Bearer)
// + X-B24-Domain header (see settings.get.ts). Body parsing is inside try so a
// malformed body returns the route's own {error} contract, not Nitro's default.

import { frameRestCall } from '../utils/liveDeps'
import { bearerToken, handleWriteSetting } from '../utils/settingsHandler'
import { withSpan } from '../utils/telemetrySpan'
import { httpOutcomeForStatus, portalHash } from '../utils/telemetryAttributes'

// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + PII-safe outcome (incl. the
// admin-gate `forbidden`) + hashed portal id. The setting body is NEVER attached to the span.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  let status = 200
  return withSpan(
    'http.settings.post',
    { 'http.method': 'POST', 'http.op': 'settings.save' },
    async () => {
      let value: string
      try {
        const body = (await readBody(event)) as { value?: unknown } | null
        value = String(body?.value ?? '')
      } catch {
        status = 400
        setResponseStatus(event, status)
        return { error: 'invalid body' }
      }
      const res = await handleWriteSetting({ callRest: frameRestCall }, token, domain, value)
      status = res.status
      setResponseStatus(event, status)
      return res.body
    },
    () => ({ 'http.outcome': httpOutcomeForStatus(status), 'portal.hash': portalHash(domain) })
  )
})
