import { describe, expect, it, vi } from 'vitest'
import { loadPortalLedger, recomputeAllPayments } from '../server/utils/distributionLedgerWrite'
import { handleLedgerRequest, type LedgerRequestDeps } from '../server/utils/ledgerRequest'
import { handleRecomputeRequest, type RecomputeRequestDeps } from '../server/utils/recomputeRequest'
import { buildPaymentListCall, buildPaymentRowsListCall, parsePaymentCarrier } from '../app/utils/distributionLedger'
import { buildUfFieldNameCamel, DISTRIBUTION_SP_FIELDS, PAYMENT_SP_FIELDS } from '../app/config/distributionSp'
import type { LedgerCard } from '../server/utils/distributionLedgerWrite'

const PSP = { entityTypeId: 1044, id: 44 }
const DSP = { entityTypeId: 1046, id: 46 }
const parentUf = buildUfFieldNameCamel(DSP.id, DISTRIBUTION_SP_FIELDS.parentPayment.postfix)

const payMarkerUf = buildUfFieldNameCamel(PSP.id, PAYMENT_SP_FIELDS.marker.postfix)
const reqUf = buildUfFieldNameCamel(PSP.id, PAYMENT_SP_FIELDS.requiresRedistribution.postfix)
const pTotalUf = buildUfFieldNameCamel(PSP.id, PAYMENT_SP_FIELDS.total.postfix)
const pCurrUf = buildUfFieldNameCamel(PSP.id, PAYMENT_SP_FIELDS.currency.postfix)
const rowStatusUf = buildUfFieldNameCamel(DSP.id, DISTRIBUTION_SP_FIELDS.status.postfix)
const rowKindUf = buildUfFieldNameCamel(DSP.id, DISTRIBUTION_SP_FIELDS.targetKind.postfix)
const rowIdUf = buildUfFieldNameCamel(DSP.id, DISTRIBUTION_SP_FIELDS.targetId.postfix)
const dAmountUf = buildUfFieldNameCamel(DSP.id, DISTRIBUTION_SP_FIELDS.amount.postfix)
const dCurrUf = buildUfFieldNameCamel(DSP.id, DISTRIBUTION_SP_FIELDS.currency.postfix)

function fakeCall(handlers: Record<string, (params: Record<string, unknown>) => Record<string, unknown>>) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    const h = handlers[method]
    if (!h) throw new Error(`unexpected ${method}`)
    return h(params)
  })
  return { call, calls }
}

describe('builders', () => {
  it('buildPaymentListCall — newest-first, selects UF state + marker', () => {
    const { params } = buildPaymentListCall(PSP, 50)
    expect(params.entityTypeId).toBe(1044)
    expect(params.order).toEqual({ id: 'desc' })
    expect(params.select).toContain(payMarkerUf)
    expect(params.start).toBe(50)
  })
  it('buildPaymentRowsListCall — all rows of a payment (no status filter)', () => {
    const { params } = buildPaymentRowsListCall(DSP, PSP, '500')
    expect((params.filter as Record<string, unknown>)[parentUf]).toBe(500)
    expect((params.filter as Record<string, unknown>)[rowStatusUf]).toBeUndefined() // NOT filtered by status
  })
  it('parsePaymentCarrier — reads total/currency/requiresRedistribution', () => {
    expect(parsePaymentCarrier({ id: 500, [pTotalUf]: '100', [pCurrUf]: 'BYN', [reqUf]: 'Y' }, PSP))
      .toEqual({ id: '500', total: 100, currency: 'BYN', requiresRedistribution: true })
    expect(parsePaymentCarrier({ [pTotalUf]: '1' }, PSP)).toBeNull() // no id
  })
})

describe('loadPortalLedger', () => {
  it('lists payment carriers newest-first, each with all its rows', async () => {
    const { call } = fakeCall({
      'crm.item.list': (params) => {
        if (params.entityTypeId === 1044) {
          return { result: { items: [
            { id: 2, [pTotalUf]: '200', [pCurrUf]: 'BYN', [reqUf]: 'N' },
            { id: 1, [pTotalUf]: '100', [pCurrUf]: 'BYN', [reqUf]: 'Y' }
          ] } }
        }
        // rows for a payment (any status)
        const parent = (params.filter as Record<string, unknown>)[parentUf]
        if (parent === 1) return { result: { items: [{ id: 9, [dAmountUf]: '100', [dCurrUf]: 'BYN', [rowKindUf]: 'invoice', [rowIdUf]: '39', [rowStatusUf]: 'active' }] } }
        return { result: { items: [] } }
      }
    })
    const cards = await loadPortalLedger(PSP, DSP, call)
    expect(cards).toHaveLength(2)
    expect(cards[0]!.id).toBe('2') // newest first (order preserved from list)
    expect(cards[1]!.requiresRedistribution).toBe(true)
    expect(cards[1]!.rows).toHaveLength(1)
    expect(cards[1]!.rows[0]!.targetId).toBe('39')
  })
})

const OUT: LedgerCard[] = [{ id: '1', total: 100, currency: 'BYN', requiresRedistribution: false, rows: [] }]
function deps(over: Partial<LedgerRequestDeps> = {}): LedgerRequestDeps {
  return {
    enabled: true,
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    loadLedger: async () => OUT,
    ...over
  }
}
const input = { accessToken: 't', domain: 'x.bitrix24.by' }

describe('handleLedgerRequest', () => {
  it('returns the cards for an admin', async () => {
    const res = await handleLedgerRequest(deps(), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ provisioned: true, cards: OUT })
  })
  it('404 when disabled', async () => {
    expect((await handleLedgerRequest(deps({ enabled: false }), input)).status).toBe(404)
  })
  it('400 without creds, 409 not installed, 403 not admin', async () => {
    expect((await handleLedgerRequest(deps(), { accessToken: '', domain: '' })).status).toBe(400)
    expect((await handleLedgerRequest(deps({ memberIdByDomain: async () => '' }), input)).status).toBe(409)
    expect((await handleLedgerRequest(deps({ validateFrame: async () => ({ userId: '7', isAdmin: false }) }), input)).status).toBe(403)
  })
  it('200 {provisioned:false} when SPs are not provisioned (loadLedger null)', async () => {
    const res = await handleLedgerRequest(deps({ loadLedger: async () => null }), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ provisioned: false, cards: [] })
  })
  it('502 when the load throws', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('rest down')
    }
    expect((await handleLedgerRequest(deps({ loadLedger: boom }), input)).status).toBe(502)
  })
})

describe('recomputeAllPayments', () => {
  it('recomputes «осталось» for every payment carrier from its active rows', async () => {
    const rowStatus = buildUfFieldNameCamel(DSP.id, DISTRIBUTION_SP_FIELDS.status.postfix)
    const { call, calls } = fakeCall({
      'crm.item.list': (params) => {
        if (params.entityTypeId === 1044) return { result: { items: [{ id: 1, [pTotalUf]: '100', [pCurrUf]: 'BYN' }, { id: 2, [pTotalUf]: '50', [pCurrUf]: 'BYN' }] } }
        // active rows per payment (for recompute): payment 1 has a 30 row, payment 2 none
        const parent = (params.filter as Record<string, unknown>)[parentUf]
        if (parent === 1) return { result: { items: [{ [dAmountUf]: '30', [dCurrUf]: 'BYN', [rowStatus]: 'active' }] } }
        return { result: { items: [] } }
      },
      'crm.item.update': () => ({ result: { item: {} } })
    })
    const n = await recomputeAllPayments(PSP, DSP, call)
    expect(n).toBe(2)
    const updates = calls.filter(c => c.method === 'crm.item.update')
    expect(updates.some(u => u.params.id === 1)).toBe(true) // remaining 70
    expect(updates.some(u => u.params.id === 2)).toBe(true) // remaining 50
  })
})

function rdeps(over: Partial<RecomputeRequestDeps> = {}): RecomputeRequestDeps {
  return { enabled: true, memberIdByDomain: async () => 'M1', validateFrame: async () => ({ userId: '7', isAdmin: true }), recompute: async () => 5, ...over }
}

describe('handleRecomputeRequest', () => {
  it('recomputes and returns the count for an admin', async () => {
    const res = await handleRecomputeRequest(rdeps(), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, recomputed: 5 })
  })
  it('404 disabled, 403 not admin, 409 not installed', async () => {
    expect((await handleRecomputeRequest(rdeps({ enabled: false }), input)).status).toBe(404)
    expect((await handleRecomputeRequest(rdeps({ validateFrame: async () => ({ userId: '7', isAdmin: false }) }), input)).status).toBe(403)
    expect((await handleRecomputeRequest(rdeps({ memberIdByDomain: async () => '' }), input)).status).toBe(409)
  })
  it('200 {provisioned:false} when SPs not provisioned', async () => {
    const res = await handleRecomputeRequest(rdeps({ recompute: async () => null }), input)
    expect(res.body).toEqual({ provisioned: false, recomputed: 0 })
  })
})
