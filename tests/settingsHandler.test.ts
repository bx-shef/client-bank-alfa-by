import { describe, expect, it } from 'vitest'
import { APP_SETTING_KEY } from '../server/utils/appSettings'
import { bearerToken, handleReadSetting, handleWriteSetting, verifyFrameAdmin, type SettingsIO } from '../server/utils/settingsHandler'

/** Fake IO backed by a per-host app.option store, recording every REST call so we
 *  can assert isolation (a token only ever hits its own portal host). `admin` controls the
 *  `profile.ADMIN` flag the fake returns (default true, so writes are allowed by default). */
function makeIO(admin = true) {
  const byHost: Record<string, Record<string, unknown>> = {}
  const calls: { host: string, accessToken: string, method: string, params?: Record<string, unknown> }[] = []
  const io: SettingsIO = {
    callRest: async (host, accessToken, method, params) => {
      calls.push({ host, accessToken, method, params })
      byHost[host] ??= {}
      if (method === 'profile') return { result: { ID: '1', ADMIN: admin } }
      if (method === 'app.option.set') {
        Object.assign(byHost[host], (params?.options as Record<string, unknown>) ?? {})
        return { result: true }
      }
      if (method === 'app.option.get') return { result: { ...byHost[host] } }
      return { result: {} }
    }
  }
  return { io, calls, byHost }
}

describe('bearerToken', () => {
  it('extracts the token from a Bearer header (case-insensitive scheme)', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def')
    expect(bearerToken('bearer  xyz ')).toBe('xyz')
  })
  it('returns empty for missing / non-Bearer headers', () => {
    expect(bearerToken(undefined)).toBe('')
    expect(bearerToken('')).toBe('')
    expect(bearerToken('Basic abc')).toBe('')
    expect(bearerToken('abc.def')).toBe('')
  })
})

describe('handleReadSetting', () => {
  it('400 when the frame token or domain is missing (no REST call made)', async () => {
    const { io, calls } = makeIO()
    expect((await handleReadSetting(io, '', 'a.bitrix24.by')).status).toBe(400)
    expect((await handleReadSetting(io, 'AT', '')).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('200 with null before anything is written', async () => {
    const { io } = makeIO()
    expect(await handleReadSetting(io, 'AT', 'a.bitrix24.by')).toEqual({ status: 200, body: { value: null } })
  })

  it('reads back a value written for the same portal', async () => {
    const { io } = makeIO()
    await handleWriteSetting(io, 'AT', 'a.bitrix24.by', 'hello')
    expect(await handleReadSetting(io, 'AT', 'a.bitrix24.by')).toEqual({ status: 200, body: { value: 'hello' } })
  })

  it('502 when the REST call throws', async () => {
    const io: SettingsIO = {
      callRest: async () => {
        throw new Error('network down')
      }
    }
    const res = await handleReadSetting(io, 'AT', 'a.bitrix24.by')
    expect(res.status).toBe(502)
    expect(res.body.error).toBe('upstream error')
  })
})

describe('handleWriteSetting', () => {
  it('400 when the frame token or domain is missing', async () => {
    const { io, calls } = makeIO()
    expect((await handleWriteSetting(io, '', 'a.bitrix24.by', 'x')).status).toBe(400)
    expect((await handleWriteSetting(io, 'AT', '', 'x')).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('200 and sets the app.option key', async () => {
    const { io, byHost } = makeIO()
    expect(await handleWriteSetting(io, 'AT', 'a.bitrix24.by', 'v')).toEqual({ status: 200, body: { ok: true } })
    expect(byHost['a.bitrix24.by']?.[APP_SETTING_KEY]).toBe('v')
  })

  it('writes/reads under a custom key (chat settings use SETTINGS_KEY)', async () => {
    const { io, byHost } = makeIO()
    await handleWriteSetting(io, 'AT', 'a.bitrix24.by', '{"chat":1}', 'cb_settings_v1')
    expect(byHost['a.bitrix24.by']?.['cb_settings_v1']).toBe('{"chat":1}')
    expect(byHost['a.bitrix24.by']?.[APP_SETTING_KEY]).toBeUndefined() // separate key untouched
    expect((await handleReadSetting(io, 'AT', 'a.bitrix24.by', 'cb_settings_v1')).body.value).toBe('{"chat":1}')
    // default key still reads its own (empty) slot
    expect((await handleReadSetting(io, 'AT', 'a.bitrix24.by')).body.value).toBeNull()
  })

  it('502 when the REST call throws', async () => {
    const io: SettingsIO = {
      callRest: async () => {
        throw new Error('boom')
      }
    }
    expect((await handleWriteSetting(io, 'AT', 'a.bitrix24.by', 'v')).status).toBe(502)
  })

  it('403 when the caller is NOT a portal admin — and the write never runs (#182)', async () => {
    const { io, calls, byHost } = makeIO(false) // profile.ADMIN = false
    const res = await handleWriteSetting(io, 'AT', 'a.bitrix24.by', 'v', 'cb_settings_v1')
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/administrator/i)
    // The gate ran a `profile` check but NO `app.option.set` — nothing was persisted.
    expect(calls.some(c => c.method === 'app.option.set')).toBe(false)
    expect(byHost['a.bitrix24.by']?.['cb_settings_v1']).toBeUndefined()
  })

  it('403 when profile omits ADMIN entirely (fail-closed, not truthy-coerced)', async () => {
    const io: SettingsIO = { callRest: async () => ({ result: { ID: '7' } }) } // no ADMIN key
    expect((await handleWriteSetting(io, 'AT', 'a.bitrix24.by', 'v')).status).toBe(403)
  })

  it('verifies admin BEFORE writing (profile precedes app.option.set)', async () => {
    const { io, calls } = makeIO(true)
    await handleWriteSetting(io, 'AT', 'a.bitrix24.by', 'v')
    const iProfile = calls.findIndex(c => c.method === 'profile')
    const iSet = calls.findIndex(c => c.method === 'app.option.set')
    expect(iProfile).toBeGreaterThanOrEqual(0)
    expect(iSet).toBeGreaterThan(iProfile)
  })
})

describe('verifyFrameAdmin', () => {
  it('true only when profile.ADMIN === true (strict boolean)', async () => {
    const mk = (adminVal: unknown): SettingsIO => ({ callRest: async () => ({ result: { ADMIN: adminVal } }) })
    expect((await verifyFrameAdmin(mk(true), 'AT', 'h')).isAdmin).toBe(true)
    expect((await verifyFrameAdmin(mk('Y'), 'AT', 'h')).isAdmin).toBe(false) // not coerced
    expect((await verifyFrameAdmin(mk(1), 'AT', 'h')).isAdmin).toBe(false)
    expect((await verifyFrameAdmin(mk(undefined), 'AT', 'h')).isAdmin).toBe(false)
  })

  it('ok:false / status 502 (fail-closed) when the profile call throws', async () => {
    const io: SettingsIO = {
      callRest: async () => {
        throw new Error('down')
      }
    }
    const r = await verifyFrameAdmin(io, 'AT', 'h')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(502)
    expect(r.isAdmin).toBe(false)
  })
})

describe('settingsHandler isolation', () => {
  it('a portal only ever reaches its own host with its own token', async () => {
    const { io, calls } = makeIO()
    await handleWriteSetting(io, 'tok-A', 'a.bitrix24.by', 'AAA')
    await handleWriteSetting(io, 'tok-B', 'b.bitrix24.by', 'BBB')

    expect((await handleReadSetting(io, 'tok-A', 'a.bitrix24.by')).body.value).toBe('AAA')
    expect((await handleReadSetting(io, 'tok-B', 'b.bitrix24.by')).body.value).toBe('BBB')

    // Token A never touched host B and vice versa — the handler passes the token
    // straight to the domain the caller presented, and B24 scopes it there.
    expect(calls.some(c => c.accessToken === 'tok-A' && c.host === 'b.bitrix24.by')).toBe(false)
    expect(calls.some(c => c.accessToken === 'tok-B' && c.host === 'a.bitrix24.by')).toBe(false)
  })
})
