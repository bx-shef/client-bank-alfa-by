// Pure {status, body} logic for the UI settings routes. The caller is
// authenticated by the Bitrix24 FRAME access token it presents (Authorization:
// Bearer) — B24 scopes that token to the caller's own portal, so there is no
// member_id to trust and no way to reach another portal's data. The REST call is
// injected (io.callRest), so this is unit-testable without the network.

import { APP_SETTING_KEY, pickAppOption } from './appSettings'

export interface SettingsIO {
  callRest: (host: string, accessToken: string, method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export interface HandlerResult {
  status: number
  body: Record<string, unknown>
}

/** GET: read an `app.option` value by key using the caller's frame token + domain.
 *  `key` defaults to the test setting; the chat-settings route passes SETTINGS_KEY. */
export async function handleReadSetting(io: SettingsIO, accessToken: string, domain: string, key: string = APP_SETTING_KEY): Promise<HandlerResult> {
  if (!accessToken || !domain) return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  try {
    const res = await io.callRest(domain, accessToken, 'app.option.get', {})
    return { status: 200, body: { value: pickAppOption(res, key) } }
  } catch {
    return { status: 502, body: { error: 'upstream error' } }
  }
}

/**
 * Verify the frame token controls its portal AND read the caller's `profile.ADMIN`, in one cheap
 * `profile` call (basic scope). Token-only: `app.option` is scoped by the frame token itself, so we
 * do NOT require the portal be installed / look up a member_id — an install race or purge window must
 * not reject a valid admin. `{ ok:false, status:502 }` on any throw (rejected/expired token or
 * transport) — the module doesn't distinguish and stays fail-closed (no write happens). Never throws.
 * Mirrors the `profile.ADMIN` gate already used by /api/bank/connect. #182.
 */
export async function verifyFrameAdmin(io: SettingsIO, accessToken: string, domain: string): Promise<{ ok: boolean, isAdmin: boolean, status?: number }> {
  try {
    const res = await io.callRest(domain, accessToken, 'profile', {})
    const result = res?.result as { ADMIN?: unknown } | undefined
    return { ok: true, isAdmin: result?.ADMIN === true }
  } catch {
    return { ok: false, isAdmin: false, status: 502 }
  }
}

/**
 * POST: write an `app.option` value by key using the caller's frame token + domain.
 *
 * ADMIN-ONLY (#182). Writing `app.option` arms portal-wide behavior: chat/error-chat targets, the
 * recognition map, and the `autoDistribute` switch that lets the worker MUTATE the portal's CRM
 * (pay deal payments, move invoices to a paid stage, fire triggers). The in-portal client hides the
 * form from non-admins (`useIsAdmin`), but that is cosmetic — this route is the real authority, so a
 * non-admin (or anyone replaying a frame token) must be rejected HERE. Gate is at the single write
 * choke point, so every write route (chat-settings, settings) is covered and a new one can't forget it.
 */
export async function handleWriteSetting(io: SettingsIO, accessToken: string, domain: string, value: string, key: string = APP_SETTING_KEY): Promise<HandlerResult> {
  if (!accessToken || !domain) return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  const admin = await verifyFrameAdmin(io, accessToken, domain)
  if (!admin.ok) return { status: admin.status ?? 502, body: { error: 'upstream error' } }
  if (!admin.isAdmin) return { status: 403, body: { error: 'settings write requires a portal administrator' } }
  try {
    await io.callRest(domain, accessToken, 'app.option.set', { options: { [key]: value } })
    return { status: 200, body: { ok: true } }
  } catch {
    return { status: 502, body: { error: 'upstream error' } }
  }
}

/** Extract the bearer token from an Authorization header. */
export function bearerToken(header: string | undefined): string {
  const h = (header ?? '').trim()
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : ''
}
