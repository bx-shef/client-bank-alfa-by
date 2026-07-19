// Orchestration for one incoming B24 event POST, over injected side effects. Two
// layers, both fully unit-testable with fakes:
//   processB24Event  — PURE verify + decide (reads only) → an `action`.
//   handleEventRequest — apply the action: enqueue it (primary; consumer is the
//                        single writer), and — because B24 does NOT resend online
//                        events (see docs/B24_EVENTS.md) — write the store
//                        SYNCHRONOUSLY as a fallback when the queue is unavailable,
//                        so an install/uninstall is never lost.
// The Nitro route (server/api/b24/events.post.ts) wires the real deps (pg, crypto,
// queue) and reads the request body. See docs/B24_EVENTS.md.

import type { PortalCredentials } from '../../app/types/b24Events'
import {
  appTokenVerdict,
  B24_EVENT_INSTALL,
  B24_EVENT_UNINSTALL,
  eventCode,
  extractPortalCredentials,
  parseInstallEvent,
  parseUninstallEvent
} from '../../app/utils/b24Events'
import { B24_DELETION_EVENTS } from '../../app/config/b24'
import type { DeletionJob, EventJob } from '../queue/topology'
import type { PortalToken } from './tokenStore'

/** Raw deletion-entity fields extracted at ingestion (classification is deferred to the consumer,
 *  which has the portal's SP config). `id` is a validated digit string. */
export interface DeletionEntityFields {
  eventCode: string
  entityId: string
  entityTypeId?: number
}

/**
 * Reads the handler needs — verification only. The handler NEVER writes the store
 * itself: it decides an `action` and the route enqueues it, so the consumer is the
 * single writer. `loadStoredToken` is a read used to authenticate an uninstall.
 */
export interface B24EventDeps {
  /** application_token configured via env (`B24_APPLICATION_TOKEN`), or '' if unset. */
  envToken: string
  /** Stored application_token for a portal, or '' if unknown. */
  loadStoredToken: (memberId: string) => Promise<string>
}

/** The store mutation a verified event implies — enqueued by the route, applied by
 *  the consumer. `register` persists credentials; `unregister` removes EVERYTHING
 *  for the portal (uninstall always purges — a removed app keeps no data). */
export type B24EventAction
  = | { type: 'register', memberId: string, credentials: PortalCredentials }
    | { type: 'unregister', memberId: string }
    | { type: 'reconcile-deletion', memberId: string, deletion: DeletionEntityFields }

/** What the route should return: an HTTP status, a small JSON body, and (on accept)
 *  the action to enqueue. No `action` ⇒ nothing to persist (denied / ignored). */
export interface B24EventResult {
  status: number
  body: Record<string, unknown>
  action?: B24EventAction
}

function deny(verdict: 'forbidden' | 'unconfigured'): B24EventResult {
  // 503 when we can't yet authenticate (portal unknown / token unconfigured) so
  // the caller fails closed; 403 for a present-but-wrong token.
  return { status: verdict === 'unconfigured' ? 503 : 403, body: { error: `application_token ${verdict}` } }
}

/**
 * Verify a parsed event payload and decide what to persist. Pure over reads only —
 * never writes and never throws for an authenticity failure (maps it to 403/503);
 * a malformed payload yields 400. Secrets are never put in the body/thrown messages.
 * The route enqueues `result.action` (if any); the consumer applies it.
 */
export async function processB24Event(payload: unknown, deps: B24EventDeps): Promise<B24EventResult> {
  const code = eventCode(payload)

  if (code === B24_EVENT_INSTALL) {
    let event
    try {
      event = parseInstallEvent(payload)
    } catch {
      return { status: 400, body: { error: 'malformed ONAPPINSTALL' } }
    }
    const verdict = appTokenVerdict({ isInstall: true, incoming: event.auth.application_token, envToken: deps.envToken })
    if (verdict !== 'accept') return deny(verdict)
    return {
      status: 200,
      body: { ok: true, event: B24_EVENT_INSTALL, memberId: event.auth.member_id },
      action: { type: 'register', memberId: event.auth.member_id, credentials: extractPortalCredentials(event) }
    }
  }

  if (code === B24_EVENT_UNINSTALL) {
    let event
    try {
      event = parseUninstallEvent(payload)
    } catch {
      return { status: 400, body: { error: 'malformed ONAPPUNINSTALL' } }
    }
    const storedToken = await deps.loadStoredToken(event.auth.member_id)
    const verdict = appTokenVerdict({
      isInstall: false,
      incoming: event.auth.application_token,
      envToken: deps.envToken,
      storedToken
    })
    if (verdict !== 'accept') return deny(verdict)
    // Policy: uninstall ALWAYS removes everything for the portal — we don't keep any
    // data for a removed app (the CLEAN flag is not consulted). See docs/B24_EVENTS.md.
    return {
      status: 200,
      body: { ok: true, event: B24_EVENT_UNINSTALL, memberId: event.auth.member_id },
      action: { type: 'unregister', memberId: event.auth.member_id }
    }
  }

  // CRM deletion events (§9.2) — verify application_token (fail-closed, same as uninstall: no OAuth
  // in the payload, so authenticity is the stored/env token) and hand the raw entity fields to the
  // consumer, which classifies them with the portal's SP config and reconciles the ledger.
  if ((B24_DELETION_EVENTS as readonly string[]).includes((code || '').toUpperCase())) {
    const auth = (payload as { auth?: Record<string, unknown> } | null)?.auth ?? {}
    const memberId = String(auth.member_id ?? '').trim()
    if (!memberId) return { status: 400, body: { error: 'malformed deletion event' } }
    const verdict = appTokenVerdict({
      isInstall: false,
      incoming: String(auth.application_token ?? ''),
      envToken: deps.envToken,
      storedToken: await deps.loadStoredToken(memberId)
    })
    if (verdict !== 'accept') return deny(verdict)

    const fields = (payload as { data?: { FIELDS?: Record<string, unknown> } } | null)?.data?.FIELDS ?? {}
    const rawId = fields.ID
    // A deletion with no usable id is authentic but carries nothing to reconcile — ACK, don't enqueue.
    if (typeof rawId !== 'string' && typeof rawId !== 'number') return { status: 200, body: { ok: true, ignored: 'deletion: no id' } }
    const entityId = String(rawId).trim()
    if (!/^\d+$/.test(entityId)) return { status: 200, body: { ok: true, ignored: 'deletion: bad id' } }
    const etid = Number(fields.ENTITY_TYPE_ID)
    return {
      status: 200,
      body: { ok: true, event: code, memberId },
      action: {
        type: 'reconcile-deletion',
        memberId,
        deletion: { eventCode: code, entityId, entityTypeId: Number.isInteger(etid) && etid > 0 ? etid : undefined }
      }
    }
  }

  // An event we don't subscribe to — acknowledge so B24 stops retrying.
  return { status: 200, body: { ok: true, ignored: code } }
}

/** Deps for {@link handleEventRequest}: verification reads + the enqueue primary
 *  path + the synchronous fallback writers used only when the queue is unavailable. */
export interface B24RequestDeps extends B24EventDeps {
  /** Enqueue the mutation (primary). Returns false when the queue is disabled (no Redis). */
  enqueue: (job: EventJob) => Promise<boolean>
  /** Enqueue a deletion-reconcile job (§9.2). No sync fallback — a dropped deletion is recoverable
   *  via the manual «пересчитать» button, unlike a lost install. Returns false when queue disabled. */
  enqueueDeletion: (job: DeletionJob) => Promise<boolean>
  /** Fallback: persist a portal synchronously (queue unavailable). saveToken encrypts refresh.
   *  `eventTs` (B24 event timestamp) drives the ordering guard (#77). */
  saveCredentials: (token: PortalToken, eventTs: number) => Promise<void>
  /** Fallback: remove a portal synchronously (queue unavailable). Records the ordering tombstone (#77). */
  deletePortal: (memberId: string, eventTs: number) => Promise<void>
  /** AES-GCM encrypt for the refresh token carried in the queued job (never plain in Redis). */
  encrypt: (plain: string) => string
  /** Current epoch ms — injected so tests are deterministic. */
  now: () => number
}

/** How the mutation was applied. */
export type B24Outcome = 'queued' | 'sync-fallback' | 'none'

export interface B24RequestResult extends B24EventResult {
  outcome: B24Outcome
}

/** ms until the access token expires, stamped from receipt time + TTL. `expires_in`
 *  arrives as a string; missing → 3600s; explicit 0 honoured; non-finite → 3600s. */
function expiresAtFrom(expiresIn: string | number | undefined, now: number): number {
  const ttl = expiresIn === undefined ? 3600 : Number(expiresIn)
  return now + (Number.isFinite(ttl) ? ttl : 3600) * 1000
}

function domainOf(payload: unknown): string {
  return String((payload as { auth?: { domain?: string } })?.auth?.domain || '')
}
function tsOf(payload: unknown): string {
  return String((payload as { ts?: unknown })?.ts ?? '')
}

/**
 * Verify the event, then APPLY its mutation: enqueue it (primary — the consumer is
 * the single writer) and fall back to a synchronous store write when the queue is
 * unavailable (B24 does not resend online events, so a dropped enqueue would lose
 * the install forever). Returns the HTTP result plus how it was applied.
 */
export async function handleEventRequest(payload: unknown, deps: B24RequestDeps): Promise<B24RequestResult> {
  const result = await processB24Event(payload, { envToken: deps.envToken, loadStoredToken: deps.loadStoredToken })
  if (result.status !== 200 || !result.action) return { ...result, outcome: 'none' }

  const action = result.action
  const domain = domainOf(payload)
  const ts = tsOf(payload)

  // Deletion-reconcile (§9.2): enqueue only. Unlike install/uninstall there is NO synchronous
  // fallback — a deletion dropped when Redis is down is recoverable via the manual «пересчитать»
  // button, so we don't hold up the webhook. `none` outcome ⇒ not enqueued (queue disabled/down).
  if (action.type === 'reconcile-deletion') {
    const delJob: DeletionJob = {
      memberId: action.memberId,
      domain,
      eventCode: action.deletion.eventCode,
      entityId: action.deletion.entityId,
      entityTypeId: action.deletion.entityTypeId,
      ts
    }
    let enq = false
    try {
      enq = await deps.enqueueDeletion(delJob)
    } catch {
      // Redis down — no sync fallback (recoverable via «пересчитать»); ACK the webhook anyway.
    }
    return { ...result, outcome: enq ? 'queued' : 'none' }
  }

  const expiresAt = action.type === 'register' ? expiresAtFrom(action.credentials.expiresIn, deps.now()) : 0

  const job: EventJob = action.type === 'register'
    ? {
        memberId: action.memberId,
        domain,
        kind: 'ONAPPINSTALL',
        ts,
        credentials: {
          accessToken: action.credentials.accessToken ?? '',
          refreshTokenEnc: deps.encrypt(action.credentials.refreshToken ?? ''),
          expiresAt,
          applicationToken: action.credentials.applicationToken
        }
      }
    : { memberId: action.memberId, domain, kind: 'ONAPPUNINSTALL', ts }

  // Primary: enqueue. A thrown enqueue (Redis down) is treated the same as a
  // disabled queue — fall through to the synchronous write.
  let queued = false
  try {
    queued = await deps.enqueue(job)
  } catch {
    // Redis threw — leave queued=false and fall through to the synchronous write.
  }
  if (queued) return { ...result, outcome: 'queued' }

  // Fallback (queue unavailable): write synchronously so the non-resent event isn't lost.
  const eventTs = Number(ts) || 0
  if (action.type === 'register') {
    await deps.saveCredentials({
      memberId: action.memberId,
      domain: action.credentials.domain,
      accessToken: action.credentials.accessToken ?? '',
      refreshToken: action.credentials.refreshToken ?? '',
      expiresAt,
      applicationToken: action.credentials.applicationToken
    }, eventTs)
  } else {
    await deps.deletePortal(action.memberId, eventTs)
  }
  return { ...result, outcome: 'sync-fallback' }
}
