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

/** GET: read the app-level setting using the caller's frame token + domain. */
export async function handleReadSetting(io: SettingsIO, accessToken: string, domain: string): Promise<HandlerResult> {
  if (!accessToken || !domain) return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  try {
    const res = await io.callRest(domain, accessToken, 'app.option.get', {})
    return { status: 200, body: { value: pickAppOption(res, APP_SETTING_KEY) } }
  } catch {
    return { status: 502, body: { error: 'upstream error' } }
  }
}

/** POST: write the app-level setting using the caller's frame token + domain. */
export async function handleWriteSetting(io: SettingsIO, accessToken: string, domain: string, value: string): Promise<HandlerResult> {
  if (!accessToken || !domain) return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  try {
    await io.callRest(domain, accessToken, 'app.option.set', { options: { [APP_SETTING_KEY]: value } })
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
