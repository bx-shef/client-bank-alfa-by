// POST /api/chat-settings { chat, errorChat } — write the CALLER'S portal chat
// settings to app.option under SETTINGS_KEY. Auth = B24 frame token + X-B24-Domain
// (see chat-settings.get.ts). The body is normalized through parsePortalSettings
// (defensive: coerces/clamps every field) before serialize, so a malformed or
// hostile body can never poison the stored blob the worker later reads.

import { frameRestCall } from '../utils/liveDeps'
import { bearerToken, handleWriteSetting } from '../utils/settingsHandler'
import { withSpan } from '../utils/telemetrySpan'
import { httpOutcomeForStatus, portalHash } from '../utils/telemetryAttributes'
import { SETTINGS_KEY, parsePortalSettings, serializePortalSettings } from '../../app/utils/settings'

// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + PII-safe outcome (incl. the
// admin-gate `forbidden`) + hashed portal id. The settings body is NEVER attached to the span.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  let status = 200
  return withSpan(
    'http.chat-settings.post',
    { 'http.method': 'POST', 'http.op': 'settings.save' },
    async () => {
      let normalized: string
      try {
        const body = await readBody(event)
        // Round-trip through the defensive parser: unknown input → sane, typed JSON.
        normalized = serializePortalSettings(parsePortalSettings(JSON.stringify(body ?? {})))
      } catch {
        status = 400
        setResponseStatus(event, status)
        return { error: 'invalid body' }
      }
      const res = await handleWriteSetting({ callRest: frameRestCall }, token, domain, normalized, SETTINGS_KEY)
      status = res.status
      setResponseStatus(event, status)
      return res.body
    },
    () => ({ 'http.outcome': httpOutcomeForStatus(status), 'portal.hash': portalHash(domain) })
  )
})
