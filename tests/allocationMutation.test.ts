import { describe, expect, it } from 'vitest'
import { buildAllocationMutation, buildTriggerExecution } from '../app/utils/allocationMutation'
import type { AllocationCandidate } from '../app/utils/allocation'

const cand = (kind: AllocationCandidate['kind'], id: string): Pick<AllocationCandidate, 'kind' | 'id'> => ({ kind, id })

describe('buildAllocationMutation', () => {
  it('deal-payment → crm.item.payment.pay with numeric id', () => {
    expect(buildAllocationMutation(cand('deal-payment', '42'))).toEqual({
      method: 'crm.item.payment.pay', params: { id: 42 }, kind: 'deal-payment', id: '42'
    })
  })

  it('unsupported target kinds → null (no v1 mutation)', () => {
    // invoice w/o a configured stage is inert; deal/smart-process are trigger targets.
    expect(buildAllocationMutation(cand('invoice', '1'))).toBeNull()
    expect(buildAllocationMutation(cand('deal', '2'))).toBeNull()
    expect(buildAllocationMutation(cand('smart-process', '3'))).toBeNull()
  })

  it('invoice WITH configured paid stage → crm.item.update to that stage', () => {
    expect(buildAllocationMutation(cand('invoice', '7'), { invoicePaidStageId: 'DT31_11:P' })).toEqual({
      method: 'crm.item.update',
      params: { entityTypeId: 31, id: 7, fields: { stageId: 'DT31_11:P' } },
      kind: 'invoice',
      id: '7'
    })
  })

  it('invoice with configured stage but blank/non-integer/non-positive id → null', () => {
    const opts = { invoicePaidStageId: 'DT31_11:P' }
    expect(buildAllocationMutation(cand('invoice', ''), opts)).toBeNull()
    expect(buildAllocationMutation(cand('invoice', 'abc'), opts)).toBeNull()
    expect(buildAllocationMutation(cand('invoice', '4.5'), opts)).toBeNull()
    expect(buildAllocationMutation(cand('invoice', ' 5 '), opts)).toBeNull()
    expect(buildAllocationMutation(cand('invoice', '0'), opts)).toBeNull()
  })

  it('invoice with blank/whitespace configured stage → null (не указана → не трогаем)', () => {
    expect(buildAllocationMutation(cand('invoice', '7'), { invoicePaidStageId: '' })).toBeNull()
    expect(buildAllocationMutation(cand('invoice', '7'), { invoicePaidStageId: '   ' })).toBeNull()
  })

  it('deal / smart-process ignore the invoice stage config (trigger targets)', () => {
    const opts = { invoicePaidStageId: 'DT31_11:P' }
    expect(buildAllocationMutation(cand('deal', '2'), opts)).toBeNull()
    expect(buildAllocationMutation(cand('smart-process', '3'), opts)).toBeNull()
  })

  it('deal-payment with blank / non-integer / non-positive id → null (never emit a malformed pay call)', () => {
    expect(buildAllocationMutation(cand('deal-payment', ''))).toBeNull()
    expect(buildAllocationMutation(cand('deal-payment', 'abc'))).toBeNull()
    expect(buildAllocationMutation(cand('deal-payment', '4.5'))).toBeNull() // Number() would coerce to 4.5
    expect(buildAllocationMutation(cand('deal-payment', ' 5 '))).toBeNull() // Number() would coerce to 5
    expect(buildAllocationMutation(cand('deal-payment', '0'))).toBeNull() // not a real (positive) payment id
    expect(buildAllocationMutation(cand('deal-payment', 'Infinity'))).toBeNull()
  })
})

describe('buildTriggerExecution', () => {
  const opts = { triggerCode: 'money.in-1' }

  it('deal → crm.automation.trigger.execute with OWNER_TYPE_ID=2', () => {
    expect(buildTriggerExecution(cand('deal', '6'), opts)).toEqual({
      method: 'crm.automation.trigger.execute',
      params: { CODE: 'money.in-1', OWNER_TYPE_ID: 2, OWNER_ID: 6 },
      kind: 'deal',
      id: '6'
    })
  })

  it('smart-process → OWNER_TYPE_ID = its entityTypeId', () => {
    expect(buildTriggerExecution({ kind: 'smart-process', id: '9', entityTypeId: 1032 }, opts)).toEqual({
      method: 'crm.automation.trigger.execute',
      params: { CODE: 'money.in-1', OWNER_TYPE_ID: 1032, OWNER_ID: 9 },
      kind: 'smart-process',
      id: '9'
    })
  })

  it('smart-process WITHOUT a valid entityTypeId → null (can\'t guess the dynamic OWNER_TYPE_ID)', () => {
    expect(buildTriggerExecution({ kind: 'smart-process', id: '9' }, opts)).toBeNull()
    expect(buildTriggerExecution({ kind: 'smart-process', id: '9', entityTypeId: 0 }, opts)).toBeNull()
    expect(buildTriggerExecution({ kind: 'smart-process', id: '9', entityTypeId: 10.5 }, opts)).toBeNull()
  })

  it('no / blank / malformed triggerCode → null (не настроен → не трогаем)', () => {
    expect(buildTriggerExecution(cand('deal', '6'))).toBeNull() // no opts
    expect(buildTriggerExecution(cand('deal', '6'), { triggerCode: '' })).toBeNull()
    expect(buildTriggerExecution(cand('deal', '6'), { triggerCode: '   ' })).toBeNull()
    expect(buildTriggerExecution(cand('deal', '6'), { triggerCode: 'Bad Code!' })).toBeNull() // space + uppercase + !
    expect(buildTriggerExecution(cand('deal', '6'), { triggerCode: 'ПлатёжПришёл' })).toBeNull() // non-mask chars
  })

  it('blank / non-integer / non-positive owner id → null (never send a malformed OWNER_ID)', () => {
    expect(buildTriggerExecution(cand('deal', ''), opts)).toBeNull()
    expect(buildTriggerExecution(cand('deal', 'abc'), opts)).toBeNull()
    expect(buildTriggerExecution(cand('deal', '4.5'), opts)).toBeNull()
    expect(buildTriggerExecution(cand('deal', ' 5 '), opts)).toBeNull()
    expect(buildTriggerExecution(cand('deal', '0'), opts)).toBeNull()
  })

  it('amount targets (invoice / deal-payment) → null (they go through buildAllocationMutation)', () => {
    expect(buildTriggerExecution(cand('invoice', '7'), opts)).toBeNull()
    expect(buildTriggerExecution(cand('deal-payment', '42'), opts)).toBeNull()
  })
})
