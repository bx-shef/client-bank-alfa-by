// Live wiring for B24 REST from the UI/diagnostic routes — everything goes through the
// jssdk transport (`b24Sdk.ts`), no raw `$fetch`. One module owns the env creds.
//
//  - `frameRestCall` — drop-in for the retired raw `callRest`: a REST method called with a
//    FRAME access token (Authorization: Bearer + X-B24-Domain), backed by `makeFrameRestCall`
//    (SSRF-gated jssdk client). Same signature/contract as `callRest` (throws on B24 error).
//  - `livePortalSdkCall` — a per-portal SDK `RestCall` from the STORED token, for server-side
//    work that acts AS the portal (distribution provision/ledger/recompute, worker), not as the
//    frame caller.

import { randomUUID } from 'node:crypto'
import { dbQuery } from '../db/client'
import { useServerLogger } from './serverLogger'
import { makeFrameRestCall, makePortalSdkCall, sdkPortalDeps } from './b24Sdk'
import type { RestCall } from './companyLookup'
import type { SingleFlightLeaseDeps } from './singleFlightLease'

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

/**
 * Живая проводка аренды single-flight (#538): короткий запрос через общий пул + случайный токен
 * снятия. `dbQuery` берёт соединение и отдаёт его сразу, поэтому долгая REST-цепочка операции
 * идёт БЕЗ занятого слота пула — в отличие от advisory-лока, который держал его всё время.
 */
export function liveLeaseDeps(): SingleFlightLeaseDeps {
  return {
    query: dbQuery,
    newToken: () => randomUUID(),
    // Потеря аренды посреди работы — единственный след того, что исключительность нарушилась;
    // без него разбор «откуда взялись два смарт-процесса» упирается в пустоту.
    onLeaseLost: key => useServerLogger('queue').warning(`аренда потеряна посреди работы: ${key}`)
  }
}
