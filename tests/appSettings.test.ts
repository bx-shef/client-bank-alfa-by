import { describe, expect, it } from 'vitest'
import {
  APP_SETTING_KEY,
  PortalNotInstalledError,
  pickAppOption,
  readAppSetting,
  writeAppSetting,
  type AppSettingsDeps
} from '../server/utils/appSettings'
import type { PortalToken } from '../server/utils/tokenStore'

function tok(memberId: string, domain: string): PortalToken {
  return { memberId, domain, accessToken: `at-${memberId}`, refreshToken: 'r', expiresAt: Date.now() + 3_600_000, applicationToken: 'x' }
}

/** Fake deps backed by an in-memory per-host app.option store, recording calls. */
function makeDeps(tokens: Record<string, PortalToken>) {
  const byHost: Record<string, Record<string, unknown>> = {}
  const calls: { host: string, accessToken: string, method: string, params: Record<string, unknown> }[] = []
  const deps: AppSettingsDeps = {
    loadToken: async m => tokens[m] ?? null,
    ensureFresh: async t => t,
    callRest: async (host, accessToken, method, params = {}) => {
      calls.push({ host, accessToken, method, params })
      byHost[host] ??= {}
      if (method === 'app.option.set') {
        Object.assign(byHost[host], (params.options as Record<string, unknown>) ?? {})
        return { result: true }
      }
      if (method === 'app.option.get') return { result: { ...byHost[host] } }
      return { result: {} }
    }
  }
  return { deps, calls, byHost }
}

describe('appSettings', () => {
  it('writes then reads back the value for a portal', async () => {
    const { deps } = makeDeps({ A: tok('A', 'a.bitrix24.by') })
    await writeAppSetting(deps, 'A', 'hello')
    expect(await readAppSetting(deps, 'A')).toBe('hello')
  })

  it('returns null when the option is unset', async () => {
    const { deps } = makeDeps({ A: tok('A', 'a.bitrix24.by') })
    expect(await readAppSetting(deps, 'A')).toBeNull()
  })

  it('throws PortalNotInstalledError for an unknown portal', async () => {
    const { deps } = makeDeps({})
    await expect(readAppSetting(deps, 'ZZZ')).rejects.toBeInstanceOf(PortalNotInstalledError)
    await expect(writeAppSetting(deps, 'ZZZ', 'x')).rejects.toBeInstanceOf(PortalNotInstalledError)
  })

  it('isolates portals — one portal never sees another\'s value', async () => {
    const { deps, calls } = makeDeps({
      A: tok('A', 'a.bitrix24.by'),
      B: tok('B', 'b.bitrix24.by')
    })
    await writeAppSetting(deps, 'A', 'valueA')
    await writeAppSetting(deps, 'B', 'valueB')

    expect(await readAppSetting(deps, 'A')).toBe('valueA')
    expect(await readAppSetting(deps, 'B')).toBe('valueB')

    // Each op hit only its own portal's host with its own access token.
    const aCalls = calls.filter(c => c.host === 'a.bitrix24.by')
    const bCalls = calls.filter(c => c.host === 'b.bitrix24.by')
    expect(aCalls.every(c => c.accessToken === 'at-A')).toBe(true)
    expect(bCalls.every(c => c.accessToken === 'at-B')).toBe(true)
    // No call for A ever touched B's host, and vice versa.
    expect(calls.some(c => c.accessToken === 'at-A' && c.host === 'b.bitrix24.by')).toBe(false)
    expect(calls.some(c => c.accessToken === 'at-B' && c.host === 'a.bitrix24.by')).toBe(false)
  })

  it('uses the app.option key', () => {
    expect(APP_SETTING_KEY).toBe('cb_test_setting')
  })
})

describe('pickAppOption', () => {
  it('returns the string value for a set key', () => {
    expect(pickAppOption({ result: { cb_test_setting: 'v' } }, 'cb_test_setting')).toBe('v')
  })
  it('coerces non-string values to string', () => {
    expect(pickAppOption({ result: { n: 42 } }, 'n')).toBe('42')
  })
  it('returns null for an unset key, empty result, or missing result', () => {
    expect(pickAppOption({ result: {} }, 'cb_test_setting')).toBeNull()
    expect(pickAppOption({}, 'cb_test_setting')).toBeNull()
    expect(pickAppOption(undefined, 'cb_test_setting')).toBeNull()
    expect(pickAppOption({ result: { cb_test_setting: null } }, 'cb_test_setting')).toBeNull()
  })
})
