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

  it('portal returns result:false → applied false (still counts as a made call)', async () => {
    const call = async () => ({ result: false })
    const res = await payAllocationViaRest(cand('deal-payment', '7'), call)
    expect(res.applied).toBe(false)
    expect(res.method).toBe('crm.item.payment.pay')
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
