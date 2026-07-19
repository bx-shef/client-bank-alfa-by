import { describe, expect, it } from 'vitest'
import {
  buildActiveRowsListCall,
  buildDistributionRowAddCall,
  buildMarkerListCall,
  buildNeedRecomputeCall,
  computeNeedDistribution,
  parentLinkField,
  parseLedgerRow,
  type DistributionRowInput
} from '~/utils/distributionLedger'
import { buildUfFieldName, DISTRIBUTION_SP_FIELDS, PAYMENT_SP_FIELDS } from '~/config/distributionSp'

// Pure ledger builders (#109 §9.1/§9.3): crm.item.add row + marker probe + active-rows list +
// «осталось» recompute. One source of the ledger wire shape.

const INPUT: DistributionRowInput = {
  paymentSpEtid: 1044,
  distributionSpEtid: 1046,
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
    expect(f[buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.targetKind.postfix)]).toBe('invoice')
    expect(f[buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.targetId.postfix)]).toBe('39')
    expect(f[buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.source.postfix)]).toBe('auto')
    expect(f[buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.status.postfix)]).toBe('active')
    expect(f[buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.marker.postfix)]).toBe('pay-key|invoice|39')
  })
})

describe('buildMarkerListCall', () => {
  it('filters by the marker UF and selects only id', () => {
    const { method, params } = buildMarkerListCall(1046, 'M1')
    expect(method).toBe('crm.item.list')
    expect(params.entityTypeId).toBe(1046)
    expect(params.useOriginalUfNames).toBe('Y')
    expect((params.filter as Record<string, unknown>)[buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.marker.postfix)]).toBe('M1')
    expect(params.select).toEqual(['id'])
  })
})

describe('buildActiveRowsListCall', () => {
  it('filters by parent link + status=active, paginates with start', () => {
    const { params } = buildActiveRowsListCall(1046, 1044, '500', 50)
    expect(params.useOriginalUfNames).toBe('Y')
    const filter = params.filter as Record<string, unknown>
    expect(filter.parentId1044).toBe(500)
    expect(filter[buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.status.postfix)]).toBe('active')
    expect(params.start).toBe(50)
  })
  it('omits start on the first page', () => {
    expect(buildActiveRowsListCall(1046, 1044, '500').params.start).toBeUndefined()
  })
})

describe('parseLedgerRow', () => {
  it('reads UF fields + opportunity/currency into a DistributionEntry', () => {
    const item = {
      id: '9',
      opportunity: '50.00',
      currencyId: 'BYN',
      [buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.targetKind.postfix)]: 'deal-payment',
      [buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.targetId.postfix)]: '77',
      [buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.source.postfix)]: 'manual',
      [buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.status.postfix)]: 'active'
    }
    expect(parseLedgerRow(item, 1046)).toEqual({
      targetKind: 'deal-payment', targetId: '77', amount: 50, currency: 'BYN', source: 'manual', status: 'active'
    })
  })
  it('defaults source/status safely and zeroes a non-finite amount', () => {
    const row = parseLedgerRow({ opportunity: 'x', currencyId: 'BYN' }, 1046)
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
    const { method, params } = buildNeedRecomputeCall(1044, '500', 70.005)
    expect(method).toBe('crm.item.update')
    expect(params.entityTypeId).toBe(1044)
    expect(params.id).toBe(500)
    expect(params.useOriginalUfNames).toBe('Y')
    expect((params.fields as Record<string, unknown>)[buildUfFieldName(1044, PAYMENT_SP_FIELDS.needDistributionsSum.postfix)]).toBe(70.01)
  })
})
