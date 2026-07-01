// GET /api/settings?memberId=... — read the app-level test setting for a portal
// (server-side REST by the stored portal token). Scoped strictly to memberId, so
// portals are isolated.
//
// NOTE (hardening, skeleton): memberId comes from the client and is trusted here.
// Before this leaves skeleton status, verify the caller by validating the B24
// frame access token (e.g. call `app.info` with it) so a client can't read
// another portal by passing its member_id. Tracked for the settings/#16 work.

import { PortalNotInstalledError, readAppSetting } from '../utils/appSettings'
import { liveAppSettingsDeps } from '../utils/liveDeps'

export default defineEventHandler(async (event) => {
  const memberId = String(getQuery(event).memberId || '').trim()
  if (!memberId) {
    setResponseStatus(event, 400)
    return { error: 'memberId required' }
  }
  try {
    const value = await readAppSetting(liveAppSettingsDeps(), memberId)
    return { memberId, value }
  } catch (err) {
    if (err instanceof PortalNotInstalledError) {
      setResponseStatus(event, 404)
      return { error: 'portal not installed' }
    }
    console.error('[settings.get]', (err as Error)?.message)
    setResponseStatus(event, 502)
    return { error: 'upstream error' }
  }
})
