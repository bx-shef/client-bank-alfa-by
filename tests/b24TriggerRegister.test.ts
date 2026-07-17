import { describe, expect, it } from 'vitest'
import { buildTriggerRegisterCall } from '../app/utils/b24TriggerRegister'
import { B24_PAYMENT_TRIGGER } from '../app/config/b24'

describe('buildTriggerRegisterCall', () => {
  it('builds the crm.automation.trigger.add call for a valid code + name', () => {
    expect(buildTriggerRegisterCall('cba_payment_received', 'Платёж получен')).toEqual({
      method: 'crm.automation.trigger.add',
      params: { CODE: 'cba_payment_received', NAME: 'Платёж получен' }
    })
  })

  it('trims code and name before building', () => {
    expect(buildTriggerRegisterCall('  cba_x  ', '  Имя  ')).toEqual({
      method: 'crm.automation.trigger.add',
      params: { CODE: 'cba_x', NAME: 'Имя' }
    })
  })

  it('returns null for a code failing the API mask (fail-safe, no malformed call)', () => {
    // Uppercase / spaces / cyrillic are all rejected by [a-z0-9.\-_].
    expect(buildTriggerRegisterCall('CBA_X', 'n')).toBeNull()
    expect(buildTriggerRegisterCall('cba x', 'n')).toBeNull()
    expect(buildTriggerRegisterCall('платёж', 'n')).toBeNull()
    expect(buildTriggerRegisterCall('', 'n')).toBeNull()
  })

  it('returns null for an empty name (the API rejects «Empty trigger name!»)', () => {
    expect(buildTriggerRegisterCall('cba_x', '')).toBeNull()
    expect(buildTriggerRegisterCall('cba_x', '   ')).toBeNull()
  })

  it('accepts the canonical app trigger constant (mask-valid by construction)', () => {
    const call = buildTriggerRegisterCall(B24_PAYMENT_TRIGGER.code, B24_PAYMENT_TRIGGER.name)
    expect(call).not.toBeNull()
    expect(call!.params.CODE).toBe(B24_PAYMENT_TRIGGER.code)
  })
})
