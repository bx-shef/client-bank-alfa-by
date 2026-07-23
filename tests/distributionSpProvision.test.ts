import { describe, expect, it, vi } from 'vitest'
import {
  extractCreatedSpRef,
  extractExistingFieldNames,
  provisionDistributionSp
} from '../server/utils/distributionSpProvision'
import {
  DISTRIBUTION_SP_FIELDS,
  DISTRIBUTION_SP_TITLE,
  PAYMENT_SP_FIELDS,
  PAYMENT_SP_TITLE
} from '../app/config/distributionSp'

// Provisioning transport (#109 §9.1 slice 3): idempotent probe → create-if-absent → add missing UFs.
// DI over a fake RestCall — no network.

describe('extractCreatedSpRef', () => {
  it('reads result.type.entityTypeId + id', () => {
    expect(extractCreatedSpRef({ result: { type: { entityTypeId: 1044, id: 44 } } })).toEqual({ entityTypeId: 1044, id: 44 })
  })
  it('null on malformed / non-positive / either id missing', () => {
    expect(extractCreatedSpRef({ result: {} })).toBeNull()
    expect(extractCreatedSpRef({})).toBeNull()
    expect(extractCreatedSpRef({ result: { type: { entityTypeId: 0, id: 44 } } })).toBeNull()
    expect(extractCreatedSpRef({ result: { type: { entityTypeId: 1044 } } })).toBeNull() // no id
    expect(extractCreatedSpRef({ result: { type: { entityTypeId: 1044, id: 'x' } } })).toBeNull()
  })
})

describe('extractExistingFieldNames', () => {
  it('pulls fieldName strings, tolerant of shape', () => {
    expect(extractExistingFieldNames({ result: { fields: [{ fieldName: 'UF_CRM_1_A' }, { fieldName: 'UF_CRM_1_B' }] } }))
      .toEqual(['UF_CRM_1_A', 'UF_CRM_1_B'])
    expect(extractExistingFieldNames({ result: {} })).toEqual([])
    expect(extractExistingFieldNames({ result: { fields: 'nope' } })).toEqual([])
    expect(extractExistingFieldNames({ result: { fields: [{}, { fieldName: 42 }] } })).toEqual([])
  })
})

/** Build a fake RestCall over a scripted response map keyed by method (+ optional per-call logic). */
function fakeCall(handlers: Record<string, (params: Record<string, unknown>) => Record<string, unknown>>) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    const h = handlers[method]
    if (!h) throw new Error(`unexpected method ${method}`)
    return h(params)
  })
  return { call, calls }
}

describe('provisionDistributionSp', () => {
  it('creates both SPs when absent and adds every user field', async () => {
    let nextEtid = 1044
    const { call, calls } = fakeCall({
      'crm.type.list': () => ({ result: { types: [] } }),
      'crm.type.add': () => {
        const e = nextEtid++
        return { result: { type: { entityTypeId: e, id: e } } }
      },
      'userfieldconfig.list': () => ({ result: { fields: [] } }),
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call)
    expect(res.paymentSpEtid).toBe(1044)
    expect(res.distributionSpEtid).toBe(1045)
    expect(res.createdPaymentSp).toBe(true)
    expect(res.createdDistributionSp).toBe(true)
    const totalFields = Object.values(PAYMENT_SP_FIELDS).length + Object.values(DISTRIBUTION_SP_FIELDS).length
    expect(res.addedFields).toBe(totalFields)
    expect(calls.filter(c => c.method === 'userfieldconfig.add')).toHaveLength(totalFields)
  })

  it('recovers existing SPs by title (no create) and adds only missing fields', async () => {
    const paymentEtid = 1044
    const distributionEtid = 1046
    const { call, calls } = fakeCall({
      'crm.type.list': () => ({ result: { types: [
        { entityTypeId: paymentEtid, id: paymentEtid, title: PAYMENT_SP_TITLE },
        { entityTypeId: distributionEtid, id: distributionEtid, title: DISTRIBUTION_SP_TITLE }
      ] } }),
      'userfieldconfig.list': (params) => {
        // payment SP already has ALL its fields; distribution SP has none
        const entityId = (params.filter as Record<string, unknown>).entityId
        if (entityId === `CRM_${paymentEtid}`) {
          return { result: { fields: Object.values(PAYMENT_SP_FIELDS).map(f => ({ fieldName: `UF_CRM_${paymentEtid}_${f.postfix}` })) } }
        }
        return { result: { fields: [] } }
      },
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call)
    expect(res.createdPaymentSp).toBe(false)
    expect(res.createdDistributionSp).toBe(false)
    expect(res.paymentSpEtid).toBe(paymentEtid)
    expect(res.distributionSpEtid).toBe(distributionEtid)
    expect(res.addedFields).toBe(Object.values(DISTRIBUTION_SP_FIELDS).length)
    expect(calls.some(c => c.method === 'crm.type.add')).toBe(false)
  })

  it('skips the probe entirely when both ids are known (only ensures fields)', async () => {
    const { call, calls } = fakeCall({
      'userfieldconfig.list': () => ({ result: { fields: [] } }),
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: 100, id: 100 }, distribution: { entityTypeId: 200, id: 200 } })
    expect(res.paymentSpEtid).toBe(100)
    expect(res.distributionSpEtid).toBe(200)
    expect(res.createdPaymentSp).toBe(false)
    expect(calls.some(c => c.method === 'crm.type.list')).toBe(false)
  })

  it('is idempotent — a re-run after full provisioning adds nothing', async () => {
    const paymentEtid = 100
    const distributionEtid = 200
    const { call } = fakeCall({
      'userfieldconfig.list': (params) => {
        const entityId = (params.filter as Record<string, unknown>).entityId
        const fields = entityId === `CRM_${paymentEtid}`
          ? Object.values(PAYMENT_SP_FIELDS)
          : Object.values(DISTRIBUTION_SP_FIELDS)
        const etid = entityId === `CRM_${paymentEtid}` ? paymentEtid : distributionEtid
        return { result: { fields: fields.map(f => ({ fieldName: `UF_CRM_${etid}_${f.postfix}` })) } }
      }
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: paymentEtid, id: paymentEtid }, distribution: { entityTypeId: distributionEtid, id: distributionEtid } })
    expect(res.addedFields).toBe(0)
  })

  it('throws when crm.type.add returns no entityTypeId', async () => {
    const { call } = fakeCall({
      'crm.type.list': () => ({ result: { types: [] } }),
      'crm.type.add': () => ({ result: { type: {} } })
    })
    await expect(provisionDistributionSp(call)).rejects.toThrow(/entityTypeId/)
  })

  it('self-heals a PARTIALLY-provisioned SP: adds exactly the missing fields (by name)', async () => {
    const paymentEtid = 100
    const distributionEtid = 200
    const { call, calls } = fakeCall({
      'userfieldconfig.list': (params) => {
        const entityId = (params.filter as Record<string, unknown>).entityId
        // payment SP has ONLY the marker; distribution SP has all → payment must gain the other two
        if (entityId === `CRM_${paymentEtid}`) {
          return { result: { fields: [{ fieldName: `UF_CRM_${paymentEtid}_${PAYMENT_SP_FIELDS.marker.postfix}` }] } }
        }
        return { result: { fields: Object.values(DISTRIBUTION_SP_FIELDS).map(f => ({ fieldName: `UF_CRM_${distributionEtid}_${f.postfix}` })) } }
      },
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: paymentEtid, id: paymentEtid }, distribution: { entityTypeId: distributionEtid, id: distributionEtid } })
    const addedNames = calls
      .filter(c => c.method === 'userfieldconfig.add')
      .map(c => (c.params.field as Record<string, unknown>).fieldName)
    expect(addedNames).toEqual([
      `UF_CRM_${paymentEtid}_${PAYMENT_SP_FIELDS.total.postfix}`,
      `UF_CRM_${paymentEtid}_${PAYMENT_SP_FIELDS.currency.postfix}`,
      `UF_CRM_${paymentEtid}_${PAYMENT_SP_FIELDS.needDistributionsSum.postfix}`,
      `UF_CRM_${paymentEtid}_${PAYMENT_SP_FIELDS.requiresRedistribution.postfix}`
    ])
    expect(addedNames).not.toContain(`UF_CRM_${paymentEtid}_${PAYMENT_SP_FIELDS.marker.postfix}`)
    expect(res.addedFields).toBe(4)
  })

  it('mixed known/unknown ids: skips probe for the known SP, recovers the other by title', async () => {
    const distributionEtid = 1046
    const { call, calls } = fakeCall({
      'crm.type.list': () => ({ result: { types: [{ entityTypeId: distributionEtid, id: distributionEtid, title: DISTRIBUTION_SP_TITLE }] } }),
      'userfieldconfig.list': () => ({ result: { fields: [] } }),
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: 500, id: 500 } })
    expect(res.paymentSpEtid).toBe(500) // known → used as-is
    expect(res.distributionSpEtid).toBe(distributionEtid) // recovered by title
    expect(res.createdPaymentSp).toBe(false)
    expect(res.createdDistributionSp).toBe(false)
    expect(calls.some(c => c.method === 'crm.type.add')).toBe(false) // recovered, not created
  })

  it('falls back to probe/create when a known id is non-positive (0 / NaN)', async () => {
    const { call, calls } = fakeCall({
      'crm.type.list': () => ({ result: { types: [] } }),
      'crm.type.add': () => ({ result: { type: { entityTypeId: 1044, id: 1044 } } }),
      'userfieldconfig.list': () => ({ result: { fields: [] } }),
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: 0, id: 0 }, distribution: { entityTypeId: 1046, id: 1046 } })
    expect(res.paymentSpEtid).toBe(1044) // 0 rejected → probed/created
    expect(res.distributionSpEtid).toBe(1046)
    expect(calls.some(c => c.method === 'crm.type.list')).toBe(true) // 0 forced a probe
  })

  it('paginates crm.type.list — finds our SP on a later page (no duplicate create)', async () => {
    const paymentEtid = 1044
    let typePage = 0
    const { call, calls } = fakeCall({
      'crm.type.list': (params) => {
        // page 0: 50 unrelated types + next; page 1: our payment SP by title
        if (!params.start) {
          typePage = 1
          return { result: { types: [{ entityTypeId: 900, id: 900, title: 'Прочее' }] }, next: 50 }
        }
        return { result: { types: [{ entityTypeId: paymentEtid, id: paymentEtid, title: PAYMENT_SP_TITLE }] } }
      },
      'userfieldconfig.list': () => ({ result: { fields: [] } }),
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call, { distribution: { entityTypeId: 200, id: 200 } })
    expect(typePage).toBe(1)
    expect(res.paymentSpEtid).toBe(paymentEtid) // found on page 2
    expect(calls.some(c => c.method === 'crm.type.add')).toBe(false) // not duplicated
  })

  it('paginates userfieldconfig.list — a field present on page 2 is not re-added', async () => {
    const paymentEtid = 100
    const distributionEtid = 200
    const { call, calls } = fakeCall({
      'userfieldconfig.list': (params) => {
        const entityId = (params.filter as Record<string, unknown>).entityId
        const etid = entityId === `CRM_${paymentEtid}` ? paymentEtid : distributionEtid
        const fields = etid === paymentEtid ? Object.values(PAYMENT_SP_FIELDS) : Object.values(DISTRIBUTION_SP_FIELDS)
        // split fields across two pages
        if (!params.start) {
          return { result: { fields: fields.slice(0, 1).map(f => ({ fieldName: `UF_CRM_${etid}_${f.postfix}` })) }, next: 1 }
        }
        return { result: { fields: fields.slice(1).map(f => ({ fieldName: `UF_CRM_${etid}_${f.postfix}` })) } }
      }
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: paymentEtid, id: paymentEtid }, distribution: { entityTypeId: distributionEtid, id: distributionEtid } })
    expect(res.addedFields).toBe(0) // all fields seen across both pages → nothing re-added
    expect(calls.some(c => c.method === 'userfieldconfig.add')).toBe(false)
  })
})
