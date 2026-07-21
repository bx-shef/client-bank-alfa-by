// Bitrix24 outgoing-event webhook endpoint: POST /api/b24/events.
// Reads the raw (form-urlencoded, PHP-bracket) body and hands it to
// handleEventRequest, which verifies (fail-closed by application_token) and applies
// the mutation: enqueue onto the b24-events queue (primary — the consumer is the
// single writer) OR, if the queue is unavailable, write the store synchronously as
// a fallback. B24 does NOT resend online events, so the fallback is what prevents a
// lost install when Redis is down. See docs/B24_EVENTS.md.

import { parseBracketForm } from '../../../app/utils/b24Events'
import { dbQuery } from '../../db/client'
import { handleEventRequest } from '../../utils/b24EventsHandler'
import { getApplicationToken, saveToken, deleteToken } from '../../utils/tokenStore'
import { encryptSecret } from '../../utils/secretCrypto'
import { enqueueEvent, enqueueDeletion } from '../../queue/producers'
import { rawOauthRefresh, verifyInstallMember, type OAuthFetchFn } from '../../utils/verifyInstallMember'

export default defineEventHandler(async (event) => {
  const envToken = process.env.B24_APPLICATION_TOKEN?.trim() || ''
  // #162: bind the install member_id to the OAuth grant. Needs the app's OAuth creds to refresh; if
  // they're unset, refresh is impossible anyway (crm-sync/keep-alive are dead too) → binding degrades
  // off and install behaves as before (application_token-only). Fixed OAuth host → no SSRF.
  const clientId = process.env.B24_CLIENT_ID?.trim() || ''
  const clientSecret = process.env.B24_CLIENT_SECRET?.trim() || ''
  const bindInstallMember = clientId && clientSecret
    ? (memberId: string, refreshToken: string) => verifyInstallMember(memberId, refreshToken, {
        refresh: rawOauthRefresh(globalThis.fetch as unknown as OAuthFetchFn, { clientId, clientSecret })
      })
    : undefined
  try {
    const raw = (await readRawBody(event)) || ''
    const payload = parseBracketForm(raw)

    const result = await handleEventRequest(payload, {
      envToken,
      loadStoredToken: memberId => getApplicationToken(dbQuery, memberId),
      enqueue: enqueueEvent,
      enqueueDeletion,
      saveCredentials: async (token, eventTs) => {
        await saveToken(dbQuery, token, eventTs)
      },
      // Uninstall erases the portal token. B24 does NOT resend online events, so this sync
      // fallback is the only chance to purge when Redis is down. Activity dedup now lives in
      // B24 (the marker on the activity), so there's no local dedup map to purge here.
      // `eventTs` records the ordering tombstone (#77) so a stale register can't resurrect.
      deletePortal: async (memberId, eventTs) => {
        await deleteToken(dbQuery, memberId, eventTs)
      },
      encrypt: encryptSecret,
      now: () => Date.now(),
      bindInstallMember
    })

    if (result.action) {
      // member_id is a non-secret routing id; outcome tells whether the worker will
      // persist (queued) or we already wrote it here (sync-fallback, Redis down).
      console.info('[b24 events] %s member_id=%s (%s)', result.action.type, result.action.memberId, result.outcome)
    }

    setResponseStatus(event, result.status)
    return result.body
  } catch (err) {
    // Verify read / enqueue AND sync fallback both failed, or a malformed body:
    // log server-side (no secrets — the message may carry a memberId but never a
    // token) and return 500. Nitro would otherwise leak err.message into the body.
    console.error('[b24 events] handler error:', (err as Error)?.message)
    setResponseStatus(event, 500)
    return { error: 'internal error' }
  }
})
