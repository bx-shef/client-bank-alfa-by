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
  parseUninstallEvent,
  shouldPurgeData
} from '../../app/utils/b24Events'

/** Side effects the handler needs, injected so the logic stays pure/testable. */
export interface B24EventDeps {
  /** application_token configured via env (`B24_APPLICATION_TOKEN`), or '' if unset. */
  envToken: string
  /** Stored application_token for a portal, or '' if unknown. */
  loadStoredToken: (memberId: string) => Promise<string>
  /** Persist a portal's credentials on install (write-once application_token). */
  saveCredentials: (creds: PortalCredentials) => Promise<void>
  /** Remove a portal's data on uninstall-with-purge. */
  deletePortal: (memberId: string) => Promise<void>
}

/** What the route should return: an HTTP status and a small JSON body. */
export interface B24EventResult {
  status: number
  body: Record<string, unknown>
}

function deny(verdict: 'forbidden' | 'unconfigured'): B24EventResult {
  // 503 when we can't yet authenticate (portal unknown / token unconfigured) so
  // the caller fails closed; 403 for a present-but-wrong token.
  return { status: verdict === 'unconfigured' ? 503 : 403, body: { error: `application_token ${verdict}` } }
}

/**
 * Process a parsed event payload. Returns the HTTP outcome — never throws for
 * an authenticity failure (maps it to 403/503); only a malformed payload yields
 * 400. Secrets are never put in the body or thrown messages.
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
    await deps.saveCredentials(extractPortalCredentials(event))
    return { status: 200, body: { ok: true, event: B24_EVENT_INSTALL, memberId: event.auth.member_id } }
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
    const purge = shouldPurgeData(event.data)
    if (purge) await deps.deletePortal(event.auth.member_id)
    return { status: 200, body: { ok: true, event: B24_EVENT_UNINSTALL, purged: purge } }
  }

  // An event we don't subscribe to — acknowledge so B24 stops retrying.
  return { status: 200, body: { ok: true, ignored: code } }
}
