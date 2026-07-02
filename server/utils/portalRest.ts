// Bind a Bitrix24 RestCall to one portal: load its token, refresh if near expiry,
// and return a caller that injects the fresh access token. Pure over injected I/O
// (token store + REST), so the CRM-sync live deps are unit-testable with fakes.
//
// The returned RestCall matches the shape companyLookup.ts expects — a portal-bound
// (method, params) → response. Returns null when the portal is unknown (no token),
// so the caller can skip cleanly instead of throwing.

import type { RestCall } from './companyLookup'
import type { PortalToken } from './tokenStore'

/** I/O the binder needs, injected for testability. */
export interface PortalRestDeps {
  loadToken: (memberId: string) => Promise<PortalToken | null>
  ensureFresh: (token: PortalToken) => Promise<PortalToken>
  callRest: (host: string, accessToken: string, method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/** Build a RestCall bound to the portal `memberId`, or null if it has no token. */
export async function makePortalRestCall(memberId: string, deps: PortalRestDeps): Promise<RestCall | null> {
  const token = await deps.loadToken(memberId)
  if (!token) return null
  const fresh = await deps.ensureFresh(token)
  return (method, params) => deps.callRest(fresh.domain, fresh.accessToken, method, params)
}
