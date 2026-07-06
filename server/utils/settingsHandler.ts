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

/** POST: write an `app.option` value by key using the caller's frame token + domain. */
export async function handleWriteSetting(io: SettingsIO, accessToken: string, domain: string, value: string, key: string = APP_SETTING_KEY): Promise<HandlerResult> {
  if (!accessToken || !domain) return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
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
