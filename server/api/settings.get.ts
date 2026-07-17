// GET /api/settings — read the app-level test setting for the CALLER'S OWN portal.
// Auth = the Bitrix24 frame access token (Authorization: Bearer <token>) + the
// portal domain (X-B24-Domain). B24 scopes that token to the caller's portal, so
// there's no member_id to trust and no cross-portal access (a token can't reach
// another portal). The token is passed in a header (not a query) so it never
// lands in access logs.

import { frameRestCall } from '../utils/liveDeps'
import { bearerToken, handleReadSetting } from '../utils/settingsHandler'

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  const { status, body } = await handleReadSetting({ callRest: frameRestCall }, token, domain)
  setResponseStatus(event, status)
  return body
})
