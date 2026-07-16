import { describe, expect, it } from 'vitest'
import { executeTriggerViaRest, payAllocationViaRest } from '../server/utils/allocationMutationWrite'
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

  it('invoice WITHOUT a configured stage → skipped, NO REST call made', async () => {
    let called = false
    const call = async () => {
      called = true
      return { result: true }
    }
    const res = await payAllocationViaRest(cand('invoice', '1'), call)
    expect(res).toEqual({ applied: false, skipped: 'unsupported' })
    expect(called).toBe(false)
  })

  it('invoice WITH a configured stage → crm.item.update, applied read from {item}', async () => {
    const seen: Array<[string, Record<string, unknown>]> = []
    const call = async (method: string, params: Record<string, unknown>) => {
      seen.push([method, params])
      // Live-confirmed envelope: crm.item.update → {result:{item:{…}}} (NOT top-level {item}).
      return { result: { item: { id: 7, stageId: 'DT31_11:P' } } }
    }
    const res = await payAllocationViaRest(cand('invoice', '7'), call, { invoicePaidStageId: 'DT31_11:P' })
    expect(res).toEqual({ applied: true, method: 'crm.item.update', kind: 'invoice', id: '7' })
    expect(seen).toEqual([['crm.item.update', { entityTypeId: 31, id: 7, fields: { stageId: 'DT31_11:P' } }]])
  })

  it('invoice update with a result lacking `item` → applied false (pins the negative envelope branch)', async () => {
    const opts = { invoicePaidStageId: 'DT31_11:P' }
    // A REST call was made (method/kind/id set), but the envelope has no result.item → NOT applied.
    expect(await payAllocationViaRest(cand('invoice', '7'), async () => ({ result: {} }), opts)).toEqual({
      applied: false, method: 'crm.item.update', kind: 'invoice', id: '7'
    })
    expect((await payAllocationViaRest(cand('invoice', '7'), async () => ({ result: false }), opts)).applied).toBe(false)
    expect((await payAllocationViaRest(cand('invoice', '7'), async () => ({}), opts)).applied).toBe(false)
  })

  it('REST error propagates (job must retry)', async () => {
    const call = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(payAllocationViaRest(cand('deal-payment', '9'), call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})

describe('executeTriggerViaRest', () => {
  const opts = { triggerCode: 'money.in-1' }

  it('deal: calls crm.automation.trigger.execute (OWNER_TYPE_ID=2) and reads {result:true}', async () => {
    const seen: Array<[string, Record<string, unknown>]> = []
    const call = async (method: string, params: Record<string, unknown>) => {
      seen.push([method, params])
      return { result: true }
    }
    const res = await executeTriggerViaRest(cand('deal', '6'), call, opts)
    expect(res).toEqual({ applied: true, method: 'crm.automation.trigger.execute', kind: 'deal', id: '6' })
    expect(seen).toEqual([['crm.automation.trigger.execute', { CODE: 'money.in-1', OWNER_TYPE_ID: 2, OWNER_ID: 6 }]])
  })

  it('smart-process: OWNER_TYPE_ID = its entityTypeId', async () => {
    const seen: Array<[string, Record<string, unknown>]> = []
    const call = async (method: string, params: Record<string, unknown>) => {
      seen.push([method, params])
      return { result: true }
    }
    const res = await executeTriggerViaRest({ kind: 'smart-process', id: '9', entityTypeId: 1032 }, call, opts)
    expect(res).toEqual({ applied: true, method: 'crm.automation.trigger.execute', kind: 'smart-process', id: '9' })
    expect(seen).toEqual([['crm.automation.trigger.execute', { CODE: 'money.in-1', OWNER_TYPE_ID: 1032, OWNER_ID: 9 }]])
  })

  it('no/invalid CODE or unsupported target → skipped, NO REST call made', async () => {
    let called = false
    const call = async () => {
      called = true
      return { result: true }
    }
    // missing code
    expect(await executeTriggerViaRest(cand('deal', '6'), call)).toEqual({ applied: false, skipped: 'unsupported' })
    // amount target is not a trigger
    expect(await executeTriggerViaRest(cand('deal-payment', '42'), call, opts)).toEqual({ applied: false, skipped: 'unsupported' })
    // smart-process without entityTypeId
    expect(await executeTriggerViaRest(cand('smart-process', '9'), call, opts)).toEqual({ applied: false, skipped: 'unsupported' })
    expect(called).toBe(false)
  })

  it('portal returns result:false → applied false (call WAS made)', async () => {
    const res = await executeTriggerViaRest(cand('deal', '6'), async () => ({ result: false }), opts)
    expect(res).toEqual({ applied: false, method: 'crm.automation.trigger.execute', kind: 'deal', id: '6' })
  })

  it('missing/empty/undefined result → applied false (strict === true, no envelope-unwrap)', async () => {
    // A made call with a malformed-but-non-throwing envelope must be treated as NOT applied.
    expect((await executeTriggerViaRest(cand('deal', '6'), async () => ({}), opts)).applied).toBe(false)
    // @ts-expect-error transport tolerates a malformed (undefined) envelope defensively
    expect((await executeTriggerViaRest(cand('deal', '6'), async () => undefined, opts)).applied).toBe(false)
  })

  it('REST error propagates (job must retry)', async () => {
    const call = async () => {
      throw new Error('Application context required')
    }
    await expect(executeTriggerViaRest(cand('deal', '6'), call, opts)).rejects.toThrow('Application context required')
  })
})
