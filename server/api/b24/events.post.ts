// Bitrix24 outgoing-event webhook endpoint: POST /api/b24/events.
// Reads the raw (form-urlencoded, PHP-bracket) body, routes it through the pure
// handler, and persists/removes the portal's tokens via the DB store. Verifies
// every call by application_token (fail-closed) — see docs/B24_EVENTS.md.

import type { PortalCredentials } from '../../../app/types/b24Events'
import { parseBracketForm } from '../../../app/utils/b24Events'
import { dbQuery } from '../../db/client'
import { processB24Event } from '../../utils/b24EventsHandler'
import { deleteToken, getApplicationToken, saveToken } from '../../utils/tokenStore'
import type { PortalToken } from '../../utils/tokenStore'

/** Map the event's portal credentials to a stored token row. `expiresAt` is
 * stamped from receipt time (now) + the token TTL — not from parse time. */
function toPortalToken(c: PortalCredentials): PortalToken {
  return {
    memberId: c.memberId,
    domain: c.domain,
    accessToken: c.accessToken ?? '',
    refreshToken: c.refreshToken ?? '',
    expiresAt: Date.now() + (c.expiresIn ?? 3600) * 1000,
    applicationToken: c.applicationToken
  }
}

export default defineEventHandler(async (event) => {
  const raw = (await readRawBody(event)) || ''
  const payload = parseBracketForm(raw)

  const result = await processB24Event(payload, {
    envToken: process.env.B24_APPLICATION_TOKEN?.trim() || '',
    loadStoredToken: memberId => getApplicationToken(dbQuery, memberId),
    saveCredentials: async creds => saveToken(dbQuery, toPortalToken(creds)),
    deletePortal: memberId => deleteToken(dbQuery, memberId)
  })

  setResponseStatus(event, result.status)
  return result.body
})
