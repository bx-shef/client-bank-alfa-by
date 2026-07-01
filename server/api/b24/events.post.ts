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
import { enqueueEvent } from '../../queue/producers'

/** Map the event's portal credentials to a stored token row. `expiresAt` is
 * stamped from receipt time (now) + the token TTL — not from parse time.
 * `expiresIn` is coerced to a number (it arrives as a string from the
 * form-encoded body); a missing value defaults to 3600s, but an explicit `0`
 * is honoured (treated as "already expired", not "use default"). */
function toPortalToken(c: PortalCredentials): PortalToken {
  const ttl = c.expiresIn === undefined ? 3600 : Number(c.expiresIn)
  return {
    memberId: c.memberId,
    domain: c.domain,
    accessToken: c.accessToken ?? '',
    refreshToken: c.refreshToken ?? '',
    expiresAt: Date.now() + (Number.isFinite(ttl) ? ttl : 3600) * 1000,
    applicationToken: c.applicationToken
  }
}

export default defineEventHandler(async (event) => {
  const envToken = process.env.B24_APPLICATION_TOKEN?.trim() || ''
  try {
    const raw = (await readRawBody(event)) || ''
    const payload = parseBracketForm(raw)

    const result = await processB24Event(payload, {
      envToken,
      loadStoredToken: memberId => getApplicationToken(dbQuery, memberId),
      saveCredentials: async creds => saveToken(dbQuery, toPortalToken(creds)),
      deletePortal: memberId => deleteToken(dbQuery, memberId)
    })

    if (result.status === 200 && result.body.event === 'ONAPPINSTALL') {
      // member_id is a non-secret routing id (see docs/B24_EVENTS.md); log it so an
      // operator can copy it for the server-side check (scripts/check-app-option.sh).
      console.info('[b24 events] ONAPPINSTALL member_id=%s', result.body.memberId)
      // Surface TOFU: an install accepted without a configured env token means any
      // caller could have bootstrapped trust. Loud in logs so prod misconfig is caught.
      if (!envToken) {
        console.warn('[b24 events] ONAPPINSTALL accepted in bootstrap mode — set B24_APPLICATION_TOKEN in prod')
      }
    }

    // Fan the verified event onto the b24-events queue for async follow-up. The
    // token save above stays the authoritative synchronous step; this is best-effort
    // (no-op without Redis) and never changes the HTTP result the portal sees.
    if (result.status === 200 && (result.body.event === 'ONAPPINSTALL' || result.body.event === 'ONAPPUNINSTALL')) {
      const auth = (payload as { auth?: { member_id?: string, domain?: string }, ts?: string }).auth
      const memberId = String(result.body.memberId || auth?.member_id || '')
      if (memberId) {
        try {
          await enqueueEvent({
            memberId,
            domain: String(auth?.domain || ''),
            kind: result.body.event as 'ONAPPINSTALL' | 'ONAPPUNINSTALL',
            ts: String((payload as { ts?: unknown }).ts ?? '')
          })
        } catch (err) {
          console.error('[b24 events] enqueue failed:', (err as Error)?.message)
        }
      }
    }

    setResponseStatus(event, result.status)
    return result.body
  } catch (err) {
    // DB down / decrypt failure / unexpected: log server-side (no secrets — the
    // message may carry a memberId but never a token) and return a neutral body.
    // Nitro would otherwise put err.message in the response even in production.
    console.error('[b24 events] handler error:', (err as Error)?.message)
    setResponseStatus(event, 500)
    return { error: 'internal error' }
  }
})
