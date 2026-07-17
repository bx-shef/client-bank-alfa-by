import { describe, expect, it, vi } from 'vitest'
import { APP_SETTING_KEY, pickAppOption, readAppSettingVia } from '../server/utils/appSettings'

// appSettings.ts is now just the pure `app.option` read helpers over an already-bound jssdk
// `RestCall` — the token load / refresh / write path moved to the SDK transport (b24Sdk.ts) with
// the #191 migration, so there is no `readAppSetting`/`writeAppSetting`/`AppSettingsDeps` here to
// test. The multi-tenant isolation those tests asserted is now structural: every `RestCall` is
// bound to one portal's token (see b24Sdk.test.ts / settingsHandler.test.ts).

describe('readAppSettingVia (bound RestCall — reactive-retry path, #191)', () => {
  it('reads app.option.get through the given call and picks the key', async () => {
    const call = vi.fn(async () => ({ result: { [APP_SETTING_KEY]: 'blob' } }))
    expect(await readAppSettingVia(call, APP_SETTING_KEY)).toBe('blob')
    // It uses the ALREADY-BOUND call (no token load/refresh of its own — that is the
    // resolver's job, which is what carries the expired_token retry).
    expect(call).toHaveBeenCalledWith('app.option.get', {})
  })
  it('returns null when the key is unset', async () => {
    const call = vi.fn(async () => ({ result: {} }))
    expect(await readAppSettingVia(call, APP_SETTING_KEY)).toBeNull()
  })
  it('defaults to APP_SETTING_KEY when no key is given', async () => {
    const call = vi.fn(async () => ({ result: { [APP_SETTING_KEY]: 'default-key' } }))
    expect(await readAppSettingVia(call)).toBe('default-key')
  })
  it('propagates a throw from the bound call (transient error fails the job → clean retry)', async () => {
    const call = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(readAppSettingVia(call)).rejects.toThrow('boom')
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
