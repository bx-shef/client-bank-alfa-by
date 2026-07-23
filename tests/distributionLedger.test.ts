import { describe, expect, it } from 'vitest'
import {
  buildActiveRowsListCall,
  buildDeactivateRowCall,
  buildDistributionRowAddCall,
  buildMarkerListCall,
  buildNeedRecomputeCall,
  buildPaymentElementAddCall,
  buildPaymentMarkerListCall,
  buildPaymentReadCall,
  buildRequiresRedistributionCall,
  buildTargetRowsListCall,
  computeNeedDistribution,
  parentLinkField,
  parseLedgerRow,
  parsePaymentTotal,
  parseTargetRow,
  type DistributionRowInput
} from '~/utils/distributionLedger'
import { buildUfFieldName, DISTRIBUTION_SP_FIELDS, PAYMENT_SP_FIELDS } from '~/config/distributionSp'

// SP refs with id ≠ entityTypeId (the fix: field names key off the TYPE id, items off entityTypeId).
const PSP = { entityTypeId: 1044, id: 44 }
const DSP = { entityTypeId: 1046, id: 46 }

// Pure ledger builders (#109 §9.1/§9.3): crm.item.add row + marker probe + active-rows list +
// «осталось» recompute. One source of the ledger wire shape.

const INPUT: DistributionRowInput = {
  paymentSp: PSP,
  distributionSp: DSP,
  paymentElementId: '500',
  amount: 123.456,
  currency: 'BYN',
  targetKind: 'invoice',
  targetId: '39',
  source: 'auto',
  marker: 'pay-key|invoice|39'
}

describe('parentLinkField', () => {
  it('is parentId<paymentSpEtid> (B24 smart-process parent link, per sync-payments)', () => {
    expect(parentLinkField(1044)).toBe('parentId1044')
  })
})

describe('buildDistributionRowAddCall', () => {
  it('adds a child row: parent link, rounded amount, currency, manual opportunity + UF fields + marker', () => {
    const { method, params } = buildDistributionRowAddCall(INPUT)
    expect(method).toBe('crm.item.add')
    expect(params.entityTypeId).toBe(1046)
    expect(params.useOriginalUfNames).toBe('Y') // original UF names, not camelCase (dedup depends on it)
    const f = params.fields as Record<string, unknown>
    expect(f.parentId1044).toBe(500) // numeric parent id
    expect(f.opportunity).toBe(123.46) // round2
    expect(f.currencyId).toBe('BYN')
    expect(f.isManualOpportunity).toBe('Y')
    expect(f[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.targetKind.postfix)]).toBe('invoice')
    expect(f[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.targetId.postfix)]).toBe('39')
    expect(f[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.source.postfix)]).toBe('auto')
    expect(f[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.status.postfix)]).toBe('active')
    expect(f[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.marker.postfix)]).toBe('pay-key|invoice|39')
  })
})

describe('buildMarkerListCall', () => {
  it('filters by the marker UF and selects only id', () => {
    const { method, params } = buildMarkerListCall(DSP, 'M1')
    expect(method).toBe('crm.item.list')
    expect(params.entityTypeId).toBe(1046)
    expect(params.useOriginalUfNames).toBe('Y')
    expect((params.filter as Record<string, unknown>)[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.marker.postfix)]).toBe('M1')
    expect(params.select).toEqual(['id'])
  })
})

describe('buildActiveRowsListCall', () => {
  it('filters by parent link + status=active, paginates with start', () => {
    const { params } = buildActiveRowsListCall(DSP, PSP, '500', 50)
    expect(params.useOriginalUfNames).toBe('Y')
    const filter = params.filter as Record<string, unknown>
    expect(filter.parentId1044).toBe(500)
    expect(filter[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.status.postfix)]).toBe('active')
    expect(params.start).toBe(50)
  })
  it('omits start on the first page', () => {
    expect(buildActiveRowsListCall(DSP, PSP, '500').params.start).toBeUndefined()
  })
})

describe('parseLedgerRow', () => {
  it('reads UF fields + opportunity/currency into a DistributionEntry', () => {
    const item = {
      id: '9',
      opportunity: '50.00',
      currencyId: 'BYN',
      [buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.targetKind.postfix)]: 'deal-payment',
      [buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.targetId.postfix)]: '77',
      [buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.source.postfix)]: 'manual',
      [buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.status.postfix)]: 'active'
    }
    expect(parseLedgerRow(item, DSP)).toEqual({
      targetKind: 'deal-payment', targetId: '77', amount: 50, currency: 'BYN', source: 'manual', status: 'active'
    })
  })
  it('defaults source/status safely and zeroes a non-finite amount', () => {
    const row = parseLedgerRow({ opportunity: 'x', currencyId: 'BYN' }, DSP)
    expect(row.amount).toBe(0)
    expect(row.source).toBe('auto')
    expect(row.status).toBe('active')
  })
})

describe('computeNeedDistribution', () => {
  it('is total − Σ active same-currency (clamped ≥0)', () => {
    const rows = [
      { targetKind: 'invoice', targetId: '1', amount: 30, currency: 'BYN', source: 'auto', status: 'active' },
      { targetKind: 'invoice', targetId: '2', amount: 20, currency: 'BYN', source: 'auto', status: 'reverted' } // freed
    ] as const
    expect(computeNeedDistribution(100, 'BYN', rows)).toBe(70)
  })
  it('never negative (over-allocated → 0)', () => {
    const rows = [{ targetKind: 'invoice', targetId: '1', amount: 150, currency: 'BYN', source: 'auto', status: 'active' }] as const
    expect(computeNeedDistribution(100, 'BYN', rows)).toBe(0)
  })
})

describe('buildNeedRecomputeCall', () => {
  it('updates the payment carrier «осталось» UF with the rounded remaining', () => {
    const { method, params } = buildNeedRecomputeCall(PSP, '500', 70.005)
    expect(method).toBe('crm.item.update')
    expect(params.entityTypeId).toBe(1044)
    expect(params.id).toBe(500)
    expect(params.useOriginalUfNames).toBe('Y')
    expect((params.fields as Record<string, unknown>)[buildUfFieldName(PSP.id, PAYMENT_SP_FIELDS.needDistributionsSum.postfix)]).toBe(70.01)
  })
})

describe('buildTargetRowsListCall', () => {
  it('filters active rows by target kind+id, selects parent link + source', () => {
    const { method, params } = buildTargetRowsListCall(DSP, PSP, 'invoice', '39', 50)
    expect(method).toBe('crm.item.list')
    expect(params.useOriginalUfNames).toBe('Y')
    const filter = params.filter as Record<string, unknown>
    expect(filter[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.targetKind.postfix)]).toBe('invoice')
    expect(filter[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.targetId.postfix)]).toBe('39')
    expect(filter[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.status.postfix)]).toBe('active')
    expect(params.select).toContain('parentId1044')
    expect(params.start).toBe(50)
  })
})

describe('parseTargetRow', () => {
  it('extracts rowId, parent payment id and source', () => {
    const item = { id: '9', parentId1044: '500', [buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.source.postfix)]: 'manual' }
    expect(parseTargetRow(item, DSP, PSP)).toEqual({ rowId: '9', parentPaymentId: '500', source: 'manual' })
  })
  it('null when row or parent id is missing', () => {
    expect(parseTargetRow({ parentId1044: '500' }, DSP, PSP)).toBeNull()
    expect(parseTargetRow({ id: '9' }, DSP, PSP)).toBeNull()
  })
  it('defaults source to auto', () => {
    expect(parseTargetRow({ id: '9', parentId1044: '5' }, DSP, PSP)?.source).toBe('auto')
  })
})

describe('buildDeactivateRowCall', () => {
  it('updates status → reverted (soft, history kept)', () => {
    const { method, params } = buildDeactivateRowCall(DSP, '9')
    expect(method).toBe('crm.item.update')
    expect(params.id).toBe(9)
    expect(params.useOriginalUfNames).toBe('Y')
    expect((params.fields as Record<string, unknown>)[buildUfFieldName(DSP.id, DISTRIBUTION_SP_FIELDS.status.postfix)]).toBe('reverted')
  })
})

describe('buildRequiresRedistributionCall', () => {
  it('sets Y/N on the payment carrier', () => {
    expect((buildRequiresRedistributionCall(PSP, '500', true).params.fields as Record<string, unknown>)[buildUfFieldName(PSP.id, PAYMENT_SP_FIELDS.requiresRedistribution.postfix)]).toBe('Y')
    expect((buildRequiresRedistributionCall(PSP, '500', false).params.fields as Record<string, unknown>)[buildUfFieldName(PSP.id, PAYMENT_SP_FIELDS.requiresRedistribution.postfix)]).toBe('N')
  })
})

describe('buildPaymentReadCall / parsePaymentTotal', () => {
  it('reads a payment element by id (opportunity + currency)', () => {
    const { params } = buildPaymentReadCall(PSP, '500')
    expect((params.filter as Record<string, unknown>).id).toBe(500)
    expect(params.select).toContain('opportunity')
  })
  it('parses total + currency, zeroing a non-finite total', () => {
    expect(parsePaymentTotal({ opportunity: '100.00', currencyId: 'BYN' })).toEqual({ total: 100, currency: 'BYN' })
    expect(parsePaymentTotal({ opportunity: 'x', currencyId: 'BYN' })).toEqual({ total: 0, currency: 'BYN' })
    expect(parsePaymentTotal(undefined)).toEqual({ total: 0, currency: '' })
  })
})

describe('buildPaymentElementAddCall', () => {
  it('creates a payment carrier: opportunity, «осталось»=full, marker, client link', () => {
    const { method, params } = buildPaymentElementAddCall(PSP, { opportunity: 100.005, currency: 'BYN', marker: 'acc|doc1', companyId: '12' })
    expect(method).toBe('crm.item.add')
    expect(params.entityTypeId).toBe(1044)
    expect(params.useOriginalUfNames).toBe('Y')
    const f = params.fields as Record<string, unknown>
    expect(f.opportunity).toBe(100.01)
    expect(f.currencyId).toBe('BYN')
    expect(f.isManualOpportunity).toBe('Y')
    expect(f.companyId).toBe(12)
    expect(f[buildUfFieldName(PSP.id, PAYMENT_SP_FIELDS.needDistributionsSum.postfix)]).toBe(100.01) // nothing distributed yet
    expect(f[buildUfFieldName(PSP.id, PAYMENT_SP_FIELDS.marker.postfix)]).toBe('acc|doc1')
  })
  it('omits companyId when absent / invalid', () => {
    expect((buildPaymentElementAddCall(PSP, { opportunity: 1, currency: 'BYN', marker: 'm' }).params.fields as Record<string, unknown>).companyId).toBeUndefined()
    expect((buildPaymentElementAddCall(PSP, { opportunity: 1, currency: 'BYN', marker: 'm', companyId: '0' }).params.fields as Record<string, unknown>).companyId).toBeUndefined()
  })
})

describe('buildPaymentMarkerListCall', () => {
  it('filters by the marker UF and selects id + opportunity + currency', () => {
    const { params } = buildPaymentMarkerListCall(PSP, 'acc|doc1')
    expect(params.useOriginalUfNames).toBe('Y')
    expect((params.filter as Record<string, unknown>)[buildUfFieldName(PSP.id, PAYMENT_SP_FIELDS.marker.postfix)]).toBe('acc|doc1')
    expect(params.select).toContain('opportunity')
  })
})
