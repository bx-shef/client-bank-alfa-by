// GET /api/b24/app-option-check?memberId=... — server-side diagnostic: reads the
// app-level setting for a portal using ONLY the stored token (no browser/frame),
// proving the server can reach the portal's app.option. Used by the docker test
// script (scripts/check-app-option.sh). Guarded by B24_APPLICATION_TOKEN via the
// `X-Check-Token` HEADER ONLY, constant-time compared. Not for the UI.

import { safeEqual } from '../../../app/utils/b24Events'
import { APP_SETTING_KEY, readAppSettingVia } from '../../utils/appSettings'
import { livePortalSdkCall } from '../../utils/liveDeps'

export default defineEventHandler(async (event) => {
  const expected = process.env.B24_APPLICATION_TOKEN?.trim() || ''
  // Header only (no `?token=` fallback): a query-string token leaks into access/tunnel logs
  // and browser history. Mirrors /api/queues (also header-only). The docker script already
  // sends the `X-Check-Token` header, so this is a pure hardening with no caller change.
  const provided = (getHeader(event, 'x-check-token') || '').trim()
  if (!expected || !safeEqual(provided, expected)) {
    setResponseStatus(event, 403)
    return { error: 'forbidden' }
  }

  const memberId = String(getQuery(event).memberId || '').trim()
  if (!memberId) {
    setResponseStatus(event, 400)
    return { error: 'memberId required' }
  }
  try {
    // Stored-token SDK call (acts AS the portal, not the frame caller); null → not installed.
    const call = await livePortalSdkCall(memberId)
    if (!call) {
      setResponseStatus(event, 404)
      return { error: 'portal not installed', memberId }
    }
    const value = await readAppSettingVia(call, APP_SETTING_KEY)
    return { source: 'server', memberId, key: APP_SETTING_KEY, value }
  } catch (err) {
    console.error('[app-option-check]', (err as Error)?.message)
    setResponseStatus(event, 502)
    return { error: 'upstream error' }
  }
})
