import { describe, expect, it, vi } from 'vitest'
import { makeApplyTrigger, type ApplyTriggerDeps } from '../server/utils/applyTriggerDep'
import type { AllocationCandidate } from '../app/utils/allocation'
import type { StatementItem } from '../app/types/statement'
import type { RestCall } from '../server/utils/companyLookup'

const item = (account = 'A'): StatementItem => ({
  account, docId: 'd1', direction: 'credit', amount: 10, currency: 'BYN', purpose: 'p',
  counterparty: { name: 'C', unp: '1', account: 'BY1' }, acceptDate: '2026-07-01T00:00:00.000Z'
})
const deal = (id = '77'): AllocationCandidate => ({ kind: 'deal', id, amount: 0, currency: 'BYN' })
const smart = (id = '9', entityTypeId = 1032): AllocationCandidate => ({ kind: 'smart-process', id, amount: 0, currency: 'BYN', entityTypeId })

const fakeCall: RestCall = async () => ({})

/** Build deps with sensible defaults; override per test. */
function deps(over: Partial<ApplyTriggerDeps> = {}): ApplyTriggerDeps {
  return {
    isDemoAccount: () => false,
    resolvePortalCall: async () => fakeCall,
    executeTriggerViaRest: async () => ({ applied: true, method: 'crm.automation.trigger.execute', kind: 'deal', id: '77' }),
    ...over
  }
}

describe('makeApplyTrigger', () => {
  it('forwards the FULL candidate (incl. entityTypeId) and the CODE to the transport — the wire invariant', async () => {
    const exec = vi.fn(deps().executeTriggerViaRest)
    const applyTrigger = makeApplyTrigger(deps({ executeTriggerViaRest: exec }))
    await applyTrigger(item(), smart('9', 1032), 'M', 'cba_pay')
    // The smart-process target must reach the transport WITH its entityTypeId — else
    // buildTriggerExecution → null → the trigger silently never fires.
    expect(exec).toHaveBeenCalledTimes(1)
    const [target, call, opts] = exec.mock.calls[0]!
    expect(target).toEqual({ kind: 'smart-process', id: '9', amount: 0, currency: 'BYN', entityTypeId: 1032 })
    expect(call).toBe(fakeCall)
    expect(opts).toEqual({ triggerCode: 'cba_pay' })
  })

  it('returns the transport applied flag (fired → true)', async () => {
    const applyTrigger = makeApplyTrigger(deps())
    expect(await applyTrigger(item(), deal(), 'M', 'cba_pay')).toBe(true)
  })

  it('returns false when the transport reports not applied', async () => {
    const applyTrigger = makeApplyTrigger(deps({
      executeTriggerViaRest: async () => ({ applied: false, skipped: 'unsupported' })
    }))
    expect(await applyTrigger(item(), deal(), 'M', 'cba_pay')).toBe(false)
  })

  it('demo account → false, NO token resolve and NO transport call (never touches a real portal)', async () => {
    const resolve = vi.fn(async () => fakeCall)
    const exec = vi.fn(deps().executeTriggerViaRest)
    const applyTrigger = makeApplyTrigger(deps({ isDemoAccount: () => true, resolvePortalCall: resolve, executeTriggerViaRest: exec }))
    expect(await applyTrigger(item('DEMO'), deal(), 'M', 'cba_pay')).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  })

  it('no portal token (resolve → null) → false, transport NOT called', async () => {
    const exec = vi.fn(deps().executeTriggerViaRest)
    const applyTrigger = makeApplyTrigger(deps({ resolvePortalCall: async () => null, executeTriggerViaRest: exec }))
    expect(await applyTrigger(item(), deal(), 'M', 'cba_pay')).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('BEST-EFFORT: a thrown transport error is swallowed → false (never propagates, batch not failed)', async () => {
    const applyTrigger = makeApplyTrigger(deps({
      executeTriggerViaRest: async () => { throw new Error('Application context required') }
    }))
    // Must resolve (not reject) to false — a trigger failure must never fail the job.
    await expect(applyTrigger(item(), deal(), 'M', 'cba_pay')).resolves.toBe(false)
  })

  it('BEST-EFFORT: a token-resolve error is also swallowed → false', async () => {
    const applyTrigger = makeApplyTrigger(deps({
      resolvePortalCall: async () => { throw new Error('token store down') }
    }))
    await expect(applyTrigger(item(), deal(), 'M', 'cba_pay')).resolves.toBe(false)
  })
})
