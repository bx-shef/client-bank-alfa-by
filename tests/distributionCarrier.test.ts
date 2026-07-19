import { describe, expect, it } from 'vitest'
import { chooseCarrier, extractSmartProcessTypes, findSmartProcessByTitle, shouldProvisionSp } from '~/utils/distributionCarrier'

// Pure carrier selection (#109 §2 Этап D / §9): SP element when supported+present, else activity;
// tariff up/downgrade only affects new operations (decided per-op, no migration).

describe('chooseCarrier', () => {
  it('smart-process only when supported AND provisioned', () => {
    expect(chooseCarrier({ smartProcessSupported: true, paymentSpPresent: true })).toBe('smart-process')
  })
  it('activity when the tariff does not support smart processes (downgrade → new ops as дело)', () => {
    expect(chooseCarrier({ smartProcessSupported: false, paymentSpPresent: true })).toBe('activity')
  })
  it('activity when supported but our SP is not provisioned yet', () => {
    expect(chooseCarrier({ smartProcessSupported: true, paymentSpPresent: false })).toBe('activity')
  })
  it('activity when neither', () => {
    expect(chooseCarrier({ smartProcessSupported: false, paymentSpPresent: false })).toBe('activity')
  })
})

describe('shouldProvisionSp', () => {
  it('true only when supported but not yet present (fresh install / re-upgrade / self-heal)', () => {
    expect(shouldProvisionSp({ smartProcessSupported: true, paymentSpPresent: false })).toBe(true)
  })
  it('false when already present (nothing to do)', () => {
    expect(shouldProvisionSp({ smartProcessSupported: true, paymentSpPresent: true })).toBe(false)
  })
  it('false when unsupported (can\'t provision → activity)', () => {
    expect(shouldProvisionSp({ smartProcessSupported: false, paymentSpPresent: false })).toBe(false)
  })
})

describe('extractSmartProcessTypes', () => {
  it('pulls result.types array; tolerant of missing/wrong shape', () => {
    expect(extractSmartProcessTypes({ result: { types: [{ entityTypeId: 1030 }] } })).toHaveLength(1)
    expect(extractSmartProcessTypes({ result: {} })).toEqual([])
    expect(extractSmartProcessTypes({})).toEqual([])
    expect(extractSmartProcessTypes({ result: { types: 'nope' } })).toEqual([])
  })
})

describe('findSmartProcessByTitle', () => {
  const resp = { result: { types: [
    { entityTypeId: '1030', title: 'Прочее' },
    { entityTypeId: 1044, title: 'Разнесение оплат' },
    { entityTypeId: 1046, title: 'Распределения' }
  ] } }

  it('returns the entityTypeId for an exact (trimmed) title match', () => {
    expect(findSmartProcessByTitle(resp, 'Разнесение оплат')).toBe(1044)
    expect(findSmartProcessByTitle(resp, '  Распределения ')).toBe(1046)
  })
  it('returns null for no match / blank title', () => {
    expect(findSmartProcessByTitle(resp, 'Нет такого')).toBeNull()
    expect(findSmartProcessByTitle(resp, '   ')).toBeNull()
  })
  it('skips a row with a non-positive/non-integer entityTypeId', () => {
    expect(findSmartProcessByTitle({ result: { types: [{ entityTypeId: 'x', title: 'A' }] } }, 'A')).toBeNull()
    expect(findSmartProcessByTitle({ result: { types: [{ entityTypeId: 0, title: 'A' }] } }, 'A')).toBeNull()
  })
})
