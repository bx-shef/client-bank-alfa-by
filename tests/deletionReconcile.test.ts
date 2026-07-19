import { describe, expect, it, vi } from 'vitest'
import { handleDeletionJob, type DeletionReconcileDeps } from '../server/utils/deletionReconcile'
import type { DeletionJob } from '../server/queue/topology'

// Pure deletion-reconcile routing (#109 §9.2): portal-installed gate → classify with SP config →
// route by kind. DI over fakes — no pg / network. Classification reuse is covered by
// deletionEvent.test.ts; here we assert the routing + gating.

const CFG = { paymentSpEtid: 1044, distributionSpEtid: 1046 }

function job(over: Partial<DeletionJob> = {}): DeletionJob {
  return { memberId: 'M1', domain: 'x.bitrix24.by', eventCode: 'ONCRMDEALDELETE', entityId: '15', ts: '100', ...over }
}

function deps(over: Partial<DeletionReconcileDeps> = {}): DeletionReconcileDeps {
  return {
    portalInstalled: async () => true,
    loadSpConfig: async () => CFG,
    reconcileTargetDeletion: async () => 0,
    notifyCompanyDeleted: async () => {},
    notifyCarrierDamaged: async () => {},
    recomputeParent: async () => {},
    ...over
  }
}

describe('handleDeletionJob', () => {
  it('drops the job when the portal is no longer installed (never classifies)', async () => {
    const loadSpConfig = vi.fn(async () => CFG)
    const res = await handleDeletionJob(job(), deps({ portalInstalled: async () => false, loadSpConfig }))
    expect(res.outcome).toBe('dropped-uninstalled')
    expect(loadSpConfig).not.toHaveBeenCalled()
  })

  it('deal → reconcile-target with affected count', async () => {
    const reconcileTargetDeletion = vi.fn(async () => 3)
    const res = await handleDeletionJob(job({ eventCode: 'ONCRMDEALDELETE' }), deps({ reconcileTargetDeletion }))
    expect(res).toMatchObject({ outcome: 'reconciled-target', kind: 'deal', affected: 3 })
    expect(reconcileTargetDeletion).toHaveBeenCalledWith(expect.objectContaining({ entityId: '15' }), 'deal')
  })

  it('invoice (dynamic, etid 31) → reconcile-target', async () => {
    const res = await handleDeletionJob(job({ eventCode: 'ONCRMDYNAMICITEMDELETE', entityTypeId: 31, entityId: '39' }), deps())
    expect(res).toMatchObject({ outcome: 'reconciled-target', kind: 'invoice' })
  })

  it('company → notify (error chat)', async () => {
    const notifyCompanyDeleted = vi.fn(async () => {})
    const res = await handleDeletionJob(job({ eventCode: 'ONCRMCOMPANYDELETE', entityId: '7' }), deps({ notifyCompanyDeleted }))
    expect(res).toMatchObject({ outcome: 'notified-company', kind: 'company' })
    expect(notifyCompanyDeleted).toHaveBeenCalledOnce()
  })

  it('our payment-carrier SP → notify (structure damage §5)', async () => {
    const notifyCarrierDamaged = vi.fn(async () => {})
    const res = await handleDeletionJob(job({ eventCode: 'ONCRMDYNAMICITEMDELETE', entityTypeId: 1044, entityId: '100' }), deps({ notifyCarrierDamaged }))
    expect(res).toMatchObject({ outcome: 'notified-carrier', kind: 'payment-carrier' })
    expect(notifyCarrierDamaged).toHaveBeenCalledOnce()
  })

  it('our distribution SP row → recompute parent', async () => {
    const recomputeParent = vi.fn(async () => {})
    const res = await handleDeletionJob(job({ eventCode: 'ONCRMDYNAMICITEMDELETE', entityTypeId: 1046, entityId: '200' }), deps({ recomputeParent }))
    expect(res).toMatchObject({ outcome: 'recomputed-parent', kind: 'distribution' })
    expect(recomputeParent).toHaveBeenCalledOnce()
  })

  it('unrelated dynamic type → skipped-irrelevant (no reconcile action fired)', async () => {
    const notifyCarrierDamaged = vi.fn(async () => {})
    const reconcileTargetDeletion = vi.fn(async () => 0)
    const res = await handleDeletionJob(
      job({ eventCode: 'ONCRMDYNAMICITEMDELETE', entityTypeId: 1099, entityId: '5' }),
      deps({ notifyCarrierDamaged, reconcileTargetDeletion })
    )
    expect(res).toMatchObject({ outcome: 'skipped-irrelevant', kind: 'other' })
    expect(notifyCarrierDamaged).not.toHaveBeenCalled()
    expect(reconcileTargetDeletion).not.toHaveBeenCalled()
  })

  it('without SP config, a dynamic non-invoice item is irrelevant (fail-safe, no accidental match)', async () => {
    const res = await handleDeletionJob(
      job({ eventCode: 'ONCRMDYNAMICITEMDELETE', entityTypeId: 1044, entityId: '100' }),
      deps({ loadSpConfig: async () => ({}) })
    )
    expect(res.outcome).toBe('skipped-irrelevant')
  })

  it('propagates a reconcile transport error (BullMQ retries)', async () => {
    const reconcileTargetDeletion = async (): Promise<never> => {
      throw new Error('rest down')
    }
    await expect(handleDeletionJob(job(), deps({ reconcileTargetDeletion }))).rejects.toThrow(/rest down/)
  })
})
