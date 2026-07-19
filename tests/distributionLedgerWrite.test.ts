import { describe, expect, it, vi } from 'vitest'
import {
  extractAddedItemId,
  extractListItems,
  findDistributionByMarker,
  loadActiveDistributions,
  recomputeNeedDistribution,
  writeDistributionRow
} from '../server/utils/distributionLedgerWrite'
import { buildUfFieldName, DISTRIBUTION_SP_FIELDS, PAYMENT_SP_FIELDS } from '../app/config/distributionSp'
import type { DistributionRowInput } from '../app/utils/distributionLedger'

// Ledger transport (#109 §9.1/§9.3): idempotent row write (find-by-marker) + active-rows load
// (paginated) + «осталось» recompute. DI over a fake RestCall — no network.

const INPUT: DistributionRowInput = {
  paymentSpEtid: 1044, distributionSpEtid: 1046, paymentElementId: '500',
  amount: 50, currency: 'BYN', targetKind: 'invoice', targetId: '39', source: 'auto', marker: 'M1'
}

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

const statusUf = buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.status.postfix)

describe('extractors', () => {
  it('extractAddedItemId reads result.item.id', () => {
    expect(extractAddedItemId({ result: { item: { id: 9 } } })).toBe('9')
    expect(extractAddedItemId({ result: {} })).toBeNull()
  })
  it('extractListItems reads result.items', () => {
    expect(extractListItems({ result: { items: [{ id: 1 }] } })).toHaveLength(1)
    expect(extractListItems({ result: {} })).toEqual([])
  })
})

describe('findDistributionByMarker', () => {
  it('returns the first matching row id, or null', async () => {
    const { call } = fakeCall({ 'crm.item.list': () => ({ result: { items: [{ id: 7 }] } }) })
    expect(await findDistributionByMarker(1046, 'M1', call)).toBe('7')
  })
  it('empty marker → null without a REST call', async () => {
    const { call } = fakeCall({})
    expect(await findDistributionByMarker(1046, '', call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})

describe('writeDistributionRow (idempotent)', () => {
  it('adds a new row when the marker is not present', async () => {
    const { call, calls } = fakeCall({
      'crm.item.list': () => ({ result: { items: [] } }),
      'crm.item.add': () => ({ result: { item: { id: 42 } } })
    })
    expect(await writeDistributionRow(INPUT, call)).toEqual({ id: '42', created: true })
    expect(calls.some(c => c.method === 'crm.item.add')).toBe(true)
  })
  it('returns the existing row (no add) when the marker already exists', async () => {
    const { call, calls } = fakeCall({ 'crm.item.list': () => ({ result: { items: [{ id: 8 }] } }) })
    expect(await writeDistributionRow(INPUT, call)).toEqual({ id: '8', created: false })
    expect(calls.some(c => c.method === 'crm.item.add')).toBe(false)
  })
  it('throws when add returns no id', async () => {
    const { call } = fakeCall({
      'crm.item.list': () => ({ result: { items: [] } }),
      'crm.item.add': () => ({ result: {} })
    })
    await expect(writeDistributionRow(INPUT, call)).rejects.toThrow(/no distribution row id/)
  })
})

describe('loadActiveDistributions (paginated)', () => {
  it('accumulates rows across pages', async () => {
    const row = (id: number) => ({ id, opportunity: '10', currencyId: 'BYN', [statusUf]: 'active' })
    const { call } = fakeCall({
      'crm.item.list': params => (params.start
        ? { result: { items: [row(3)] } }
        : { result: { items: [row(1), row(2)] }, next: 2 })
    })
    const rows = await loadActiveDistributions(1046, 1044, '500', call)
    expect(rows).toHaveLength(3)
    expect(rows.every(r => r.amount === 10)).toBe(true)
  })
})

describe('recomputeNeedDistribution', () => {
  it('computes total − Σ active and writes it onto the payment carrier', async () => {
    const row = (amt: string) => ({ opportunity: amt, currencyId: 'BYN', [statusUf]: 'active' })
    const { call, calls } = fakeCall({
      'crm.item.list': () => ({ result: { items: [row('30'), row('20')] } }),
      'crm.item.update': () => ({ result: { item: {} } })
    })
    const remaining = await recomputeNeedDistribution(1044, '500', 1046, 100, 'BYN', call)
    expect(remaining).toBe(50)
    const upd = calls.find(c => c.method === 'crm.item.update')!
    expect(upd.params.id).toBe(500)
    expect((upd.params.fields as Record<string, unknown>)[buildUfFieldName(1044, PAYMENT_SP_FIELDS.needDistributionsSum.postfix)]).toBe(50)
  })
})
