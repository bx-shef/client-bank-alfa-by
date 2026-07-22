import { describe, expect, it, vi } from 'vitest'
import { handleTriggerFireJob, type TriggerFireJobDeps } from '../server/utils/triggerFireJob'
import type { TriggerFireJob } from '../server/queue/topology'
import type { AllocationMutationResult } from '../server/utils/allocationMutationWrite'
import type { RestCall } from '../server/utils/companyLookup'

const call: RestCall = async () => ({})
const dealJob: TriggerFireJob = { memberId: 'M', triggerCode: 'cba_pay', targetKind: 'deal', targetId: '77', opKey: 'A|d1' }
const smartJob: TriggerFireJob = { memberId: 'M', triggerCode: 'cba_pay', targetKind: 'smart-process', targetId: '9', targetEntityTypeId: 1032, opKey: 'A|d1' }

function deps(res: AllocationMutationResult | Error, over: Partial<TriggerFireJobDeps> = {}): TriggerFireJobDeps {
  return {
    resolvePortalCall: async () => call,
    executeTriggerViaRest: vi.fn(async () => {
      if (res instanceof Error) throw res
      return res
    }),
    ...over
  }
}

describe('handleTriggerFireJob (durable trigger retry #79)', () => {
  it('confirmed fire ({result:true}) → ack (resolves)', async () => {
    const d = deps({ applied: true, method: 'crm.automation.trigger.execute', kind: 'deal', id: '77' })
    await expect(handleTriggerFireJob(dealJob, d)).resolves.toBeUndefined()
  })

  it('forwards the smart-process entityTypeId + CODE to the transport (OWNER_TYPE_ID wire)', async () => {
    const exec = vi.fn(async () => ({ applied: true } as AllocationMutationResult))
    await handleTriggerFireJob(smartJob, deps({ applied: true }, { executeTriggerViaRest: exec }))
    const [target, , opts] = exec.mock.calls[0]!
    expect(target).toEqual({ kind: 'smart-process', id: '9', entityTypeId: 1032 })
    expect(opts).toEqual({ triggerCode: 'cba_pay' })
  })

  it('unsupported/malformed (skipped) → ack + drop (a retry cannot help)', async () => {
    const d = deps({ applied: false, skipped: 'unsupported' })
    await expect(handleTriggerFireJob(dealJob, d)).resolves.toBeUndefined()
  })

  it('not confirmed (applied:false, not skipped) → THROW so BullMQ retries', async () => {
    await expect(handleTriggerFireJob(dealJob, deps({ applied: false }))).rejects.toThrow(/not confirmed/)
  })

  it('thrown transport error (e.g. «not registered») propagates → BullMQ retry (self-heals)', async () => {
    await expect(handleTriggerFireJob(dealJob, deps(new Error('trigger is not registered')))).rejects.toThrow(/not registered/)
  })

  it('no portal token (resolve → null) → THROW (pending; a bounded retry)', async () => {
    const d = deps({ applied: true }, { resolvePortalCall: async () => null })
    await expect(handleTriggerFireJob(dealJob, d)).rejects.toThrow(/no portal token/)
  })
})
