// App-level test setting stored in the portal's `app.option` (per-app, per-portal).
// Pure over injected deps (token load, refresh, REST call) so it's unit-testable
// without a DB or the network. Multi-tenant isolation is structural: every op is
// scoped to `memberId` → that portal's own token → its own app.option namespace,
// so two portals can never read/write each other's value.

import type { PortalToken } from './tokenStore'
import type { RestCall } from './companyLookup'

/** The single app.option key this skeleton reads/writes. */
export const APP_SETTING_KEY = 'cb_test_setting'

/** Pull one option value out of an app.option.get result; null when unset. */
export function pickAppOption(restResult: Record<string, unknown> | undefined, key: string): string | null {
  const options = (restResult?.result ?? {}) as Record<string, unknown>
  const value = options[key]
  return value === undefined || value === null ? null : String(value)
}

export interface AppSettingsDeps {
  /** Load the stored token for a portal, or null if not installed. */
  loadToken: (memberId: string) => Promise<PortalToken | null>
  /** Return a token with a valid access_token (refresh if near expiry). */
  ensureFresh: (token: PortalToken) => Promise<PortalToken>
  /** Call a REST method on the portal host with the access token. */
  callRest: (host: string, accessToken: string, method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export class PortalNotInstalledError extends Error {
  constructor(memberId: string) {
    super(`portal not installed: ${memberId}`)
    this.name = 'PortalNotInstalledError'
  }
}

/** Read the app-level setting for a portal. Returns null when unset. */
export async function readAppSetting(
  deps: AppSettingsDeps,
  memberId: string,
  key: string = APP_SETTING_KEY
): Promise<string | null> {
  const token = await deps.loadToken(memberId)
  if (!token) throw new PortalNotInstalledError(memberId)
  const fresh = await deps.ensureFresh(token)
  const res = await deps.callRest(fresh.domain, fresh.accessToken, 'app.option.get', {})
  return pickAppOption(res, key)
}

/** Read the app-level setting through an ALREADY-BOUND RestCall — the #191 resolver's
 *  bind-once call, which self-heals a server-side `expired_token` via force-refresh+retry.
 *  Unlike `readAppSetting` (loads+refreshes its own token, no reactive retry), this lets the
 *  crm-sync GATING settings read — which runs first and can hard-fail the whole job — share
 *  that retry, so a clock-fresh-but-rejected token doesn't stall the batch until clock-expiry.
 *  The caller resolves the portal (null → not installed → no settings) and passes the call. */
export async function readAppSettingVia(call: RestCall, key: string = APP_SETTING_KEY): Promise<string | null> {
  return pickAppOption(await call('app.option.get', {}), key)
}

/** Write the app-level setting for a portal. */
export async function writeAppSetting(
  deps: AppSettingsDeps,
  memberId: string,
  value: string,
  key: string = APP_SETTING_KEY
): Promise<void> {
  const token = await deps.loadToken(memberId)
  if (!token) throw new PortalNotInstalledError(memberId)
  const fresh = await deps.ensureFresh(token)
  await deps.callRest(fresh.domain, fresh.accessToken, 'app.option.set', { options: { [key]: value } })
}
