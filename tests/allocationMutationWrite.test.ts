import { describe, expect, it } from 'vitest'
import { payAllocationViaRest } from '../server/utils/allocationMutationWrite'
import type { AllocationCandidate } from '../app/utils/allocation'

const cand = (kind: AllocationCandidate['kind'], id: string): Pick<AllocationCandidate, 'kind' | 'id'> => ({ kind, id })

describe('payAllocationViaRest', () => {
  it('deal-payment: calls crm.item.payment.pay and reads the boolean result', async () => {
    const seen: Array<[string, Record<string, unknown>]> = []
    const call = async (method: string, params: Record<string, unknown>) => {
      seen.push([method, params])
      return { result: true }
    }
    const res = await payAllocationViaRest(cand('deal-payment', '7'), call)
    expect(res).toEqual({ applied: true, method: 'crm.item.payment.pay', kind: 'deal-payment', id: '7' })
    expect(seen).toEqual([['crm.item.payment.pay', { id: 7 }]])
  })

  it('portal returns result:false → applied false (still a made call, method/kind/id set)', async () => {
    let called = false
    const call = async () => {
      called = true
      return { result: false }
    }
    const res = await payAllocationViaRest(cand('deal-payment', '7'), call)
    expect(called).toBe(true) // the REST call WAS made (distinct from unsupported/skipped)
    expect(res).toEqual({ applied: false, method: 'crm.item.payment.pay', kind: 'deal-payment', id: '7' })
  })

  it('missing/empty result field → applied false (optional-chain tolerated)', async () => {
    expect((await payAllocationViaRest(cand('deal-payment', '7'), async () => ({}))).applied).toBe(false)
    // @ts-expect-error transport tolerates a malformed (undefined) envelope defensively
    expect((await payAllocationViaRest(cand('deal-payment', '7'), async () => undefined)).applied).toBe(false)
  })

  it('invoice + configured stage: calls crm.item.update and reads the object result', async () => {
    const seen: Array<[string, Record<string, unknown>]> = []
    const call = async (method: string, params: Record<string, unknown>) => {
      seen.push([method, params])
      return { result: { item: { id: 7, stageId: 'DT31_11:P' } } }
    }
    const res = await payAllocationViaRest(cand('invoice', '7'), call, { invoicePaidStageId: 'DT31_11:P' })
    expect(res).toEqual({ applied: true, method: 'crm.item.update', kind: 'invoice', id: '7' })
    expect(seen).toEqual([['crm.item.update', { entityTypeId: 31, id: 7, fields: { stageId: 'DT31_11:P' } }]])
  })

  it('invoice WITHOUT a configured stage → skipped, NO REST call made', async () => {
    let called = false
    const call = async () => {
      called = true
      return { result: { item: {} } }
    }
    const res = await payAllocationViaRest(cand('invoice', '7'), call) // no opts → no stage
    expect(res).toEqual({ applied: false, skipped: 'unsupported' })
    expect(called).toBe(false)
  })

  it('invoice update returning a non-object result → applied false', async () => {
    const res = await payAllocationViaRest(cand('invoice', '7'), async () => ({ result: false }), { invoicePaidStageId: 'DT31_11:P' })
    expect(res.applied).toBe(false)
  })

  it('unsupported target kind → skipped, NO REST call made', async () => {
    let called = false
    const call = async () => {
      called = true
      return { result: true }
    }
    const res = await payAllocationViaRest(cand('invoice', '1'), call)
    expect(res).toEqual({ applied: false, skipped: 'unsupported' })
    expect(called).toBe(false)
  })

  it('REST error propagates (job must retry)', async () => {
    const call = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(payAllocationViaRest(cand('deal-payment', '9'), call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
