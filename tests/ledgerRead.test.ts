import { describe, expect, it, vi } from 'vitest'
import { loadPortalLedger } from '../server/utils/distributionLedgerWrite'
import { handleLedgerRequest, type LedgerRequestDeps } from '../server/utils/ledgerRequest'
import { buildPaymentListCall, buildPaymentRowsListCall, parsePaymentCarrier } from '../app/utils/distributionLedger'
import { buildUfFieldName, DISTRIBUTION_SP_FIELDS, PAYMENT_SP_FIELDS } from '../app/config/distributionSp'
import type { LedgerCard } from '../server/utils/distributionLedgerWrite'

const payMarkerUf = buildUfFieldName(1044, PAYMENT_SP_FIELDS.marker.postfix)
const reqUf = buildUfFieldName(1044, PAYMENT_SP_FIELDS.requiresRedistribution.postfix)
const rowStatusUf = buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.status.postfix)
const rowKindUf = buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.targetKind.postfix)
const rowIdUf = buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.targetId.postfix)

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
    const { params } = buildPaymentListCall(1044, 50)
    expect(params.entityTypeId).toBe(1044)
    expect(params.useOriginalUfNames).toBe('Y')
    expect(params.order).toEqual({ id: 'desc' })
    expect(params.select).toContain(payMarkerUf)
    expect(params.start).toBe(50)
  })
  it('buildPaymentRowsListCall — all rows of a payment (no status filter)', () => {
    const { params } = buildPaymentRowsListCall(1046, 1044, '500')
    expect((params.filter as Record<string, unknown>).parentId1044).toBe(500)
    expect((params.filter as Record<string, unknown>)[rowStatusUf]).toBeUndefined() // NOT filtered by status
  })
  it('parsePaymentCarrier — reads total/currency/requiresRedistribution', () => {
    expect(parsePaymentCarrier({ id: 500, opportunity: '100', currencyId: 'BYN', [reqUf]: 'Y' }, 1044))
      .toEqual({ id: '500', total: 100, currency: 'BYN', requiresRedistribution: true })
    expect(parsePaymentCarrier({ opportunity: '1' }, 1044)).toBeNull() // no id
  })
})

describe('loadPortalLedger', () => {
  it('lists payment carriers newest-first, each with all its rows', async () => {
    const { call } = fakeCall({
      'crm.item.list': (params) => {
        if (params.entityTypeId === 1044) {
          return { result: { items: [
            { id: 2, opportunity: '200', currencyId: 'BYN', [reqUf]: 'N' },
            { id: 1, opportunity: '100', currencyId: 'BYN', [reqUf]: 'Y' }
          ] } }
        }
        // rows for a payment (any status)
        const parent = (params.filter as Record<string, unknown>).parentId1044
        if (parent === 1) return { result: { items: [{ id: 9, opportunity: '100', currencyId: 'BYN', [rowKindUf]: 'invoice', [rowIdUf]: '39', [rowStatusUf]: 'active' }] } }
        return { result: { items: [] } }
      }
    })
    const cards = await loadPortalLedger(1044, 1046, call)
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
