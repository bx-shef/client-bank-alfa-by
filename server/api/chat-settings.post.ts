// POST /api/chat-settings { chat, errorChat } — write the CALLER'S portal chat
// settings to app.option under SETTINGS_KEY. Auth = B24 frame token + X-B24-Domain
// (see chat-settings.get.ts). The body is normalized through parsePortalSettings
// (defensive: coerces/clamps every field) before serialize, so a malformed or
// hostile body can never poison the stored blob the worker later reads.

import { callRest } from '../utils/b24Rest'
import { bearerToken, handleWriteSetting } from '../utils/settingsHandler'
import { SETTINGS_KEY, parsePortalSettings, serializePortalSettings } from '../../app/utils/settings'

export default defineEventHandler(async (event) => {
  let normalized: string
  try {
    const body = await readBody(event)
    // Round-trip through the defensive parser: unknown input → sane, typed JSON.
    normalized = serializePortalSettings(parsePortalSettings(JSON.stringify(body ?? {})))
  } catch {
    setResponseStatus(event, 400)
    return { error: 'invalid body' }
  }
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const { status, body } = await handleWriteSetting({ callRest }, token, domain, normalized, SETTINGS_KEY)
  setResponseStatus(event, status)
  return body
})
