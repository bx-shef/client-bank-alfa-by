// App-level setting stored in the portal's `app.option` (per-app, per-portal). Read through an
// already-bound jssdk `RestCall` (crm-sync's per-portal resolver, or the diagnostic route's
// stored-token SDK call) — the transport is injected, so this stays unit-testable without a DB or
// the network. Multi-tenant isolation is structural: every call is bound to one portal's token →
// its own app.option namespace, so two portals can never read each other's value.

import type { RestCall } from './companyLookup'

/** The single app.option key this skeleton reads/writes. */
export const APP_SETTING_KEY = 'cb_test_setting'

/** Pull one option value out of an app.option.get result; null when unset. */
export function pickAppOption(restResult: Record<string, unknown> | undefined, key: string): string | null {
  const options = (restResult?.result ?? {}) as Record<string, unknown>
  const value = options[key]
  return value === undefined || value === null ? null : String(value)
}

/** Read the app-level setting through an already-bound `RestCall`. The caller resolves the portal
 *  (a null resolver result → not installed → no setting) and passes the SDK call; crm-sync's gating
 *  read shares that call so a server-side `expired_token` self-heals via the SDK's reactive refresh
 *  rather than stalling the batch. Returns null when the key is unset. */
export async function readAppSettingVia(call: RestCall, key: string = APP_SETTING_KEY): Promise<string | null> {
  return pickAppOption(await call('app.option.get', {}), key)
}
