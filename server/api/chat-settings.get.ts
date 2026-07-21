// GET /api/chat-settings — read the CALLER'S portal chat settings (notification
// chat + rules + error chat) from app.option under SETTINGS_KEY. Auth = the B24
// frame access token (Authorization: Bearer) + X-B24-Domain, same model as
// /api/settings (B24 scopes the token to the caller's portal). Returns the parsed,
// defensively-normalized PortalSettings — the worker reads the SAME key/shape via
// readAppSettingVia(call, SETTINGS_KEY), so UI and pipeline stay in sync.

import { frameRestCall } from '../utils/liveDeps'
import { bearerToken, handleReadSetting } from '../utils/settingsHandler'
import { withSpan } from '../utils/telemetrySpan'
import { httpOutcomeForStatus, portalHash } from '../utils/telemetryAttributes'
import { SETTINGS_KEY, parsePortalSettings } from '../../app/utils/settings'

// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed
// portal id, never the settings body. Zero overhead when telemetry is off.
export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  let status = 200
  return withSpan(
    'http.chat-settings.get',
    { 'http.method': 'GET', 'http.op': 'settings.load' },
    async () => {
      const res = await handleReadSetting({ callRest: frameRestCall }, token, domain, SETTINGS_KEY)
      status = res.status
      if (status !== 200) {
        setResponseStatus(event, status)
        return res.body
      }
      // app.option holds an untyped string — parse defensively into typed settings.
      return parsePortalSettings(typeof res.body.value === 'string' ? res.body.value : null)
    },
    () => ({ 'http.outcome': httpOutcomeForStatus(status), 'portal.hash': portalHash(domain) })
  )
})
