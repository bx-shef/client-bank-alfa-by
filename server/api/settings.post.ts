// POST /api/settings { memberId, value } — write the app-level test setting for a
// portal (server-side REST by the stored portal token). See settings.get.ts for
// the memberId-trust hardening note.

import { PortalNotInstalledError, writeAppSetting } from '../utils/appSettings'
import { liveAppSettingsDeps } from '../utils/liveDeps'

export default defineEventHandler(async (event) => {
  const body = (await readBody(event)) as { memberId?: string, value?: string } | null
  const memberId = String(body?.memberId || '').trim()
  const value = String(body?.value ?? '')
  if (!memberId) {
    setResponseStatus(event, 400)
    return { error: 'memberId required' }
  }
  try {
    await writeAppSetting(liveAppSettingsDeps(), memberId, value)
    return { ok: true, memberId }
  } catch (err) {
    if (err instanceof PortalNotInstalledError) {
      setResponseStatus(event, 404)
      return { error: 'portal not installed' }
    }
    console.error('[settings.post]', (err as Error)?.message)
    setResponseStatus(event, 502)
    return { error: 'upstream error' }
  }
})
