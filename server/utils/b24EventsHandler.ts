// Pure orchestration for one incoming B24 event POST, over injected side effects
// (token store reads/writes). Decides the HTTP outcome using the domain core
// from app/utils/b24Events; the Nitro route (server/api/b24/events.post.ts) wires
// the real deps (pg + crypto) and reads the request body. Kept dependency-free so
// it is fully unit-testable with fakes. See docs/B24_EVENTS.md.

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

  // An event we don't subscribe to — acknowledge so B24 stops retrying.
  return { status: 200, body: { ok: true, ignored: code } }
}
