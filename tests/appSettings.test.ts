import { describe, expect, it, vi } from 'vitest'
import { pickAppOption, readAppSettingVia } from '../server/utils/appSettings'
import { SETTINGS_KEY } from '../app/utils/settings'

// appSettings.ts is just the pure `app.option` read helpers over an already-bound jssdk
// `RestCall` — the token load / refresh / write path lives in the SDK transport (b24Sdk.ts, #191).
// The multi-tenant isolation is structural: every `RestCall` is bound to one portal's token (see
// b24Sdk.test.ts / settingsHandler.test.ts). Callers pass the key explicitly (SETTINGS_KEY).

describe('readAppSettingVia (bound RestCall — reactive-retry path, #191)', () => {
  it('reads app.option.get through the given call and picks the key', async () => {
    const call = vi.fn(async () => ({ result: { [SETTINGS_KEY]: 'blob' } }))
    expect(await readAppSettingVia(call, SETTINGS_KEY)).toBe('blob')
    // It uses the ALREADY-BOUND call (no token load/refresh of its own — that is the
    // resolver's job, which is what carries the expired_token retry).
    expect(call).toHaveBeenCalledWith('app.option.get', {})
  })
  it('returns null when the key is unset', async () => {
    const call = vi.fn(async () => ({ result: {} }))
    expect(await readAppSettingVia(call, SETTINGS_KEY)).toBeNull()
  })
  it('propagates a throw from the bound call (transient error fails the job → clean retry)', async () => {
    const call = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(readAppSettingVia(call, SETTINGS_KEY)).rejects.toThrow('boom')
  })
})

describe('pickAppOption', () => {
  it('returns the string value for a set key', () => {
    expect(pickAppOption({ result: { k: 'v' } }, 'k')).toBe('v')
  })
  it('coerces non-string values to string', () => {
    expect(pickAppOption({ result: { n: 42 } }, 'n')).toBe('42')
  })
  it('returns null for an unset key, empty result, or missing result', () => {
    expect(pickAppOption({ result: {} }, 'k')).toBeNull()
    expect(pickAppOption({}, 'k')).toBeNull()
    expect(pickAppOption(undefined, 'k')).toBeNull()
    expect(pickAppOption({ result: { k: null } }, 'k')).toBeNull()
  })
})
