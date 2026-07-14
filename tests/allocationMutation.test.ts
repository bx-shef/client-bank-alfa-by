import { describe, expect, it } from 'vitest'
import { buildAllocationMutation, SMART_INVOICE_ENTITY_TYPE_ID } from '../app/utils/allocationMutation'
import type { AllocationCandidate } from '../app/utils/allocation'

const cand = (kind: AllocationCandidate['kind'], id: string): Pick<AllocationCandidate, 'kind' | 'id'> => ({ kind, id })

describe('buildAllocationMutation', () => {
  it('smart-invoice entityTypeId mirrors the server constant (31)', () => {
    expect(SMART_INVOICE_ENTITY_TYPE_ID).toBe(31)
  })

  it('deal-payment → crm.item.payment.pay with numeric id (boolean result)', () => {
    expect(buildAllocationMutation(cand('deal-payment', '42'))).toEqual({
      method: 'crm.item.payment.pay', params: { id: 42 }, kind: 'deal-payment', id: '42', resultKind: 'boolean'
    })
  })

  it('invoice + configured paid stage → crm.item.update stageId (object result)', () => {
    expect(buildAllocationMutation(cand('invoice', '7'), { invoicePaidStageId: 'DT31_11:P' })).toEqual({
      method: 'crm.item.update',
      params: { entityTypeId: 31, id: 7, fields: { stageId: 'DT31_11:P' } },
      kind: 'invoice', id: '7', resultKind: 'object'
    })
  })

  it('invoice WITHOUT a configured stage → null (не указана → не трогаем)', () => {
    expect(buildAllocationMutation(cand('invoice', '7'))).toBeNull()
    expect(buildAllocationMutation(cand('invoice', '7'), {})).toBeNull()
    expect(buildAllocationMutation(cand('invoice', '7'), { invoicePaidStageId: '   ' })).toBeNull() // blank/whitespace
  })

  it('invoice with a stage but bad id → null (never emit a malformed update)', () => {
    expect(buildAllocationMutation(cand('invoice', ''), { invoicePaidStageId: 'DT31_11:P' })).toBeNull()
    expect(buildAllocationMutation(cand('invoice', '0'), { invoicePaidStageId: 'DT31_11:P' })).toBeNull()
    expect(buildAllocationMutation(cand('invoice', 'abc'), { invoicePaidStageId: 'DT31_11:P' })).toBeNull()
  })

  it('deal-payment ignores the invoice stage option', () => {
    expect(buildAllocationMutation(cand('deal-payment', '42'), { invoicePaidStageId: 'DT31_11:P' })!.method)
      .toBe('crm.item.payment.pay')
  })

  it('trigger target kinds → null (deal/smart-process handled by the trigger slice)', () => {
    expect(buildAllocationMutation(cand('deal', '2'), { invoicePaidStageId: 'DT31_11:P' })).toBeNull()
    expect(buildAllocationMutation(cand('smart-process', '3'), { invoicePaidStageId: 'DT31_11:P' })).toBeNull()
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
