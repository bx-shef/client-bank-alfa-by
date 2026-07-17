// GET /api/chat-settings — read the CALLER'S portal chat settings (notification
// chat + rules + error chat) from app.option under SETTINGS_KEY. Auth = the B24
// frame access token (Authorization: Bearer) + X-B24-Domain, same model as
// /api/settings (B24 scopes the token to the caller's portal). Returns the parsed,
// defensively-normalized PortalSettings — the worker reads the SAME key/shape via
// readAppSettingVia(call, SETTINGS_KEY), so UI and pipeline stay in sync.

import { frameRestCall } from '../utils/liveDeps'
import { bearerToken, handleReadSetting } from '../utils/settingsHandler'
import { SETTINGS_KEY, parsePortalSettings } from '../../app/utils/settings'

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const { status, body } = await handleReadSetting({ callRest: frameRestCall }, token, domain, SETTINGS_KEY)
  if (status !== 200) {
    setResponseStatus(event, status)
    return body
  }
  // app.option holds an untyped string — parse defensively into typed settings.
  return parsePortalSettings(typeof body.value === 'string' ? body.value : null)
})
