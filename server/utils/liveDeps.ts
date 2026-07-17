// Live wiring for B24 REST from the UI/diagnostic routes — everything goes through the
// jssdk transport (`b24Sdk.ts`), no raw `$fetch`. One module owns the env creds.
//
//  - `frameRestCall` — drop-in for the retired raw `callRest`: a REST method called with a
//    FRAME access token (Authorization: Bearer + X-B24-Domain), backed by `makeFrameRestCall`
//    (SSRF-gated jssdk client). Same signature/contract as `callRest` (throws on B24 error).
//  - `livePortalSdkCall` — a per-portal SDK `RestCall` from the STORED token, for a server-side
//    diagnostic that acts AS the portal (app-option-check), not as the frame caller.

import { dbQuery } from '../db/client'
import { makeFrameRestCall, makePortalSdkCall, sdkPortalDeps } from './b24Sdk'
import type { RestCall } from './companyLookup'

/** App-OAuth creds. For `frameRestCall` they are only structurally needed (a fresh frame
 *  token never refreshes); for `livePortalSdkCall` they drive the SDK's reactive refresh. */
function creds() {
  return { clientId: process.env.B24_CLIENT_ID ?? '', clientSecret: process.env.B24_CLIENT_SECRET ?? '' }
}

/** Call a REST method with a frame access token through the jssdk transport. Drop-in for the
 *  retired raw `callRest(host, accessToken, method, params)` — same signature and throw-on-error
 *  contract; the SSRF host gate lives in `makeFrameRestCall`. */
export function frameRestCall(
  host: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return makeFrameRestCall(host, accessToken, creds(), { now: Date.now })(method, params)
}

/** A per-portal SDK `RestCall` from the STORED token (loaded by memberId), or null when the
 *  portal isn't installed. For server-side diagnostics/actions that use the portal's own OAuth
 *  token (with the SDK's reactive refresh), not the frame caller's token. */
export function livePortalSdkCall(memberId: string): Promise<RestCall | null> {
  return makePortalSdkCall(memberId, sdkPortalDeps({
    query: dbQuery,
    clientId: process.env.B24_CLIENT_ID ?? '',
    clientSecret: process.env.B24_CLIENT_SECRET ?? '',
    now: Date.now
  }))
}
