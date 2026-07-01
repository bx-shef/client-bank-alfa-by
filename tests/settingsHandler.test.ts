import { describe, expect, it } from 'vitest'
import { APP_SETTING_KEY } from '../server/utils/appSettings'
import { bearerToken, handleReadSetting, handleWriteSetting, type SettingsIO } from '../server/utils/settingsHandler'

/** Fake IO backed by a per-host app.option store, recording every REST call so we
 *  can assert isolation (a token only ever hits its own portal host). */
function makeIO() {
  const byHost: Record<string, Record<string, unknown>> = {}
  const calls: { host: string, accessToken: string, method: string, params?: Record<string, unknown> }[] = []
  const io: SettingsIO = {
    callRest: async (host, accessToken, method, params) => {
      calls.push({ host, accessToken, method, params })
      byHost[host] ??= {}
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

  it('502 when the REST call throws', async () => {
    const io: SettingsIO = {
      callRest: async () => {
        throw new Error('boom')
      }
    }
    expect((await handleWriteSetting(io, 'AT', 'a.bitrix24.by', 'v')).status).toBe(502)
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
