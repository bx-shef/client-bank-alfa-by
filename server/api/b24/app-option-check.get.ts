// GET /api/b24/app-option-check?memberId=... — server-side diagnostic: reads the
// app-level setting for a portal using ONLY the stored token (no browser/frame),
// proving the server can reach the portal's app.option. Used by the docker test
// script (scripts/check-app-option.sh). Guarded by B24_APPLICATION_TOKEN via the
// `X-Check-Token` header (or `?token=`), constant-time compared. Not for the UI.

import { safeEqual } from '../../../app/utils/b24Events'
import { PortalNotInstalledError, readAppSetting } from '../../utils/appSettings'
import { liveAppSettingsDeps } from '../../utils/liveDeps'

export default defineEventHandler(async (event) => {
  const expected = process.env.B24_APPLICATION_TOKEN?.trim() || ''
  const provided = (getHeader(event, 'x-check-token') || String(getQuery(event).token || '')).trim()
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
    const value = await readAppSetting(liveAppSettingsDeps(), memberId)
    return { source: 'server', memberId, key: 'cb_test_setting', value }
  } catch (err) {
    if (err instanceof PortalNotInstalledError) {
      setResponseStatus(event, 404)
      return { error: 'portal not installed', memberId }
    }
    console.error('[app-option-check]', (err as Error)?.message)
    setResponseStatus(event, 502)
    return { error: 'upstream error' }
  }
})
