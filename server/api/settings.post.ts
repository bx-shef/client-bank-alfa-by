// POST /api/settings { value } — write the app-level test setting for the
// CALLER'S OWN portal. Auth = Bitrix24 frame access token (Authorization: Bearer)
// + X-B24-Domain header (see settings.get.ts). Body parsing is inside try so a
// malformed body returns the route's own {error} contract, not Nitro's default.

import { frameRestCall } from '../utils/liveDeps'
import { bearerToken, handleWriteSetting } from '../utils/settingsHandler'

export default defineEventHandler(async (event) => {
  let value: string
  try {
    const body = (await readBody(event)) as { value?: unknown } | null
    value = String(body?.value ?? '')
  } catch {
    setResponseStatus(event, 400)
    return { error: 'invalid body' }
  }
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const { status, body } = await handleWriteSetting({ callRest: frameRestCall }, token, domain, value)
  setResponseStatus(event, status)
  return body
})
