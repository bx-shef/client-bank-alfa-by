// POST /api/chat-settings { chat, errorChat } — write the CALLER'S portal chat
// settings to app.option under SETTINGS_KEY. Auth = B24 frame token + X-B24-Domain
// (see chat-settings.get.ts). The body is normalized through parsePortalSettings
// (defensive: coerces/clamps every field) before serialize, so a malformed or
// hostile body can never poison the stored blob the worker later reads.

import { frameRestCall } from '../utils/liveDeps'
import { bearerToken, handleWriteSetting } from '../utils/settingsHandler'
import { withSpan } from '../utils/telemetrySpan'
import { httpOutcomeForStatus, portalHash } from '../utils/telemetryAttributes'
import { SETTINGS_KEY, parsePortalSettings, serializePortalSettings, type PortalSettings } from '../../app/utils/settings'
import { mergeFormSettings } from '../../app/config/distributionSp'

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
      let incoming: PortalSettings
      try {
        const body = await readBody(event)
        // Round-trip through the defensive parser: unknown input → sane, typed JSON.
        incoming = parsePortalSettings(JSON.stringify(body ?? {}))
      } catch {
        status = 400
        setResponseStatus(event, status)
        return { error: 'invalid body' }
      }
      // ⚠ The smart-process ids come from the STORED blob, never from the form (#19): provisioning
      // writes them behind the form's back, and a form opened before «Настроить смарт-процессы»
      // would otherwise wipe them on «Сохранить» — the SPs exist in the CRM, the app no longer sees them.
      const res = await handleWriteSetting(
        { callRest: frameRestCall }, token, domain, serializePortalSettings(incoming), SETTINGS_KEY,
        mergeFormSettings(incoming)
      )
      status = res.status
      setResponseStatus(event, status)
      return res.body
    },
    () => ({ 'http.outcome': httpOutcomeForStatus(status), 'portal.hash': portalHash(domain) })
  )
})
