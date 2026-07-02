// Bitrix24 outgoing-event webhook endpoint: POST /api/b24/events.
// Reads the raw (form-urlencoded, PHP-bracket) body, VERIFIES it (fail-closed by
// application_token), and enqueues the store mutation — it never writes the DB
// itself. The b24-events consumer is the single writer: it registers the portal
// (ONAPPINSTALL) or removes everything for it (ONAPPUNINSTALL). See docs/B24_EVENTS.md.
//
// Because persistence is async, the queue is REQUIRED: if we can't enqueue (Redis
// down / not configured) we return 503 so Bitrix24 retries — no silent data loss.

import type { PortalCredentials } from '../../../app/types/b24Events'
import { parseBracketForm } from '../../../app/utils/b24Events'
import { dbQuery } from '../../db/client'
import { processB24Event } from '../../utils/b24EventsHandler'
import { getApplicationToken } from '../../utils/tokenStore'
import { encryptSecret } from '../../utils/secretCrypto'
import { enqueueEvent } from '../../queue/producers'
import type { EventJob } from '../../queue/topology'

/** Build the register EventJob, encrypting the refresh token so it never travels
 *  through Redis in clear. `expiresAt` is stamped from receipt time + the TTL
 *  (`expires_in` arrives as a string; missing → 3600s, explicit 0 honoured). */
function registerJob(creds: PortalCredentials): EventJob {
  const ttl = creds.expiresIn === undefined ? 3600 : Number(creds.expiresIn)
  return {
    memberId: creds.memberId,
    domain: creds.domain,
    kind: 'ONAPPINSTALL',
    ts: '',
    credentials: {
      accessToken: creds.accessToken ?? '',
      refreshTokenEnc: encryptSecret(creds.refreshToken ?? ''),
      expiresAt: Date.now() + (Number.isFinite(ttl) ? ttl : 3600) * 1000,
      applicationToken: creds.applicationToken
    }
  }
}

export default defineEventHandler(async (event) => {
  const envToken = process.env.B24_APPLICATION_TOKEN?.trim() || ''
  try {
    const raw = (await readRawBody(event)) || ''
    const payload = parseBracketForm(raw)
    const ts = String((payload as { ts?: unknown }).ts ?? '')

    // Verify only (reads the stored token to authenticate an uninstall) — no writes.
    const result = await processB24Event(payload, {
      envToken,
      loadStoredToken: memberId => getApplicationToken(dbQuery, memberId)
    })

    if (result.status === 200 && result.action) {
      const domain = String((payload as { auth?: { domain?: string } }).auth?.domain || '')
      const job: EventJob = result.action.type === 'register'
        ? { ...registerJob(result.action.credentials), domain, ts }
        : { memberId: result.action.memberId, domain, kind: 'ONAPPUNINSTALL', ts }

      // The consumer is the single writer — persistence is async. If the queue can't
      // take the job, fail closed with 503 so Bitrix retries (never lose the event).
      const enqueued = await enqueueEvent(job)
      if (!enqueued) {
        console.error('[b24 events] queue unavailable — cannot persist %s member_id=%s', job.kind, job.memberId)
        setResponseStatus(event, 503)
        return { error: 'queue unavailable, retry later' }
      }
      console.info('[b24 events] %s member_id=%s enqueued', job.kind, job.memberId)
    }

    setResponseStatus(event, result.status)
    return result.body
  } catch (err) {
    // Enqueue threw (Redis down) / malformed / unexpected: log server-side (no
    // secrets — the message may carry a memberId but never a token) and return 503
    // so Bitrix retries. Nitro would otherwise leak err.message into the response.
    console.error('[b24 events] handler error:', (err as Error)?.message)
    setResponseStatus(event, 503)
    return { error: 'internal error, retry later' }
  }
})
