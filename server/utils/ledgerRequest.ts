// Pure request logic for GET /api/distribution/ledger (#109, §9.3 #4). Same gate model as
// /api/distribution/provision: feature flag (default OFF), frame token (membership + ADMIN), portal
// installed. Returns the portal's payment carriers + their distribution rows for the «Распределение»
// UI. Thin over DI — unit-testable without pg / network / the SDK.

import type { LedgerCard } from './distributionLedgerWrite'

/** Injected side effects + config for {@link handleLedgerRequest}. */
export interface LedgerRequestDeps {
  /** Feature gate: OFF unless the owner opts in (default false, fail-closed). */
  enabled: boolean
  /** Resolve the caller's portal member id from its domain (proves the app is installed). */
  memberIdByDomain: (domain: string) => Promise<string>
  /** Re-check the frame token against B24: returns the user id (membership) + admin flag. */
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** Load the portal's ledger cards, or `null` when the distribution SPs are not provisioned. */
  loadLedger: (memberId: string) => Promise<LedgerCard[] | null>
}

export interface LedgerRequestResult {
  status: number
  body: Record<string, unknown>
}

/**
 * Handle one ledger read: gate → auth → load. Order: feature gate first (404), then frame auth
 * (400 no creds → 409 not installed → 401 bad token → 403 not admin), then the load. A downstream
 * error maps to 502. When the SPs are not provisioned yet, returns `200 {provisioned:false, cards:[]}`
 * (the UI shows a «настройте смарт-процессы» prompt, not an error). Never throws.
 */
export async function handleLedgerRequest(
  deps: LedgerRequestDeps,
  input: { accessToken: string, domain: string }
): Promise<LedgerRequestResult> {
  if (!deps.enabled) return { status: 404, body: { error: 'distribution disabled' } }

  const accessToken = (input.accessToken || '').trim()
  const domain = (input.domain || '').trim()
  if (!accessToken || !domain) return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }

  let memberId: string
  try {
    memberId = await deps.memberIdByDomain(domain)
  } catch {
    return { status: 502, body: { error: 'upstream error' } }
  }
  if (!memberId) return { status: 409, body: { error: 'portal not installed' } }

  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 401, body: { error: 'invalid frame token' } }
  }
  if (!frame.userId) return { status: 401, body: { error: 'invalid frame token' } }
  if (!frame.isAdmin) return { status: 403, body: { error: 'admin required' } }

  try {
    const cards = await deps.loadLedger(memberId)
    if (cards === null) return { status: 200, body: { provisioned: false, cards: [] } }
    return { status: 200, body: { provisioned: true, cards } }
  } catch {
    return { status: 502, body: { error: 'ledger read failed' } }
  }
}
