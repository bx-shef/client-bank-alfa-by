import { describe, expect, it, vi } from 'vitest'
import {
  extractAddedItemId,
  extractListItems,
  findDistributionByMarker,
  loadActiveDistributions,
  ensurePaymentElement,
  loadDistributionsByTarget,
  readPaymentTotal,
  reconcileTargetDeletion,
  recomputeNeedDistribution,
  writeDistributionRow,
  writeLedgerAllocation
} from '../server/utils/distributionLedgerWrite'
import { buildUfFieldName, DISTRIBUTION_SP_FIELDS, PAYMENT_SP_FIELDS } from '../app/config/distributionSp'
import type { DistributionRowInput } from '../app/utils/distributionLedger'
import type { StatementItem } from '../app/types/statement'
import type { AllocationCandidate } from '../app/utils/allocation'

const ufName = buildUfFieldName
const srcUf = ufName(1046, DISTRIBUTION_SP_FIELDS.source.postfix)
const needUf = ufName(1044, PAYMENT_SP_FIELDS.needDistributionsSum.postfix)
const reqUf = ufName(1044, PAYMENT_SP_FIELDS.requiresRedistribution.postfix)

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

describe('readPaymentTotal', () => {
  it('reads opportunity + currency; null when the element is gone', async () => {
    const { call } = fakeCall({ 'crm.item.list': () => ({ result: { items: [{ id: 500, opportunity: '100', currencyId: 'BYN' }] } }) })
    expect(await readPaymentTotal(1044, '500', call)).toEqual({ total: 100, currency: 'BYN' })
    const { call: empty } = fakeCall({ 'crm.item.list': () => ({ result: { items: [] } }) })
    expect(await readPaymentTotal(1044, '500', empty)).toBeNull()
  })
})

describe('loadDistributionsByTarget', () => {
  it('accumulates target rows across pages', async () => {
    const { call } = fakeCall({
      'crm.item.list': params => (params.start
        ? { result: { items: [{ id: 3, parentId1044: '500', [srcUf]: 'auto' }] } }
        : { result: { items: [{ id: 1, parentId1044: '500', [srcUf]: 'manual' }] }, next: 1 })
    })
    const rows = await loadDistributionsByTarget(1046, 1044, 'invoice', '39', call)
    expect(rows).toHaveLength(2)
  })
})

describe('reconcileTargetDeletion', () => {
  it('no rows → nothing done', async () => {
    const { call, calls } = fakeCall({ 'crm.item.list': () => ({ result: { items: [] } }) })
    expect(await reconcileTargetDeletion(1044, 1046, 'invoice', '39', call)).toEqual({ freed: 0, parentsRecomputed: 0, manualParents: 0 })
    expect(calls.some(c => c.method === 'crm.item.update')).toBe(false)
  })

  it('deactivates rows, recomputes the parent, flags manual redistribution', async () => {
    const { call, calls } = fakeCall({
      'crm.item.list': (params) => {
        // 1st list = target rows; subsequent lists = active rows (recompute) / payment read
        if (params.filter && (params.filter as Record<string, unknown>)[ufName(1046, DISTRIBUTION_SP_FIELDS.targetKind.postfix)]) {
          return { result: { items: [{ id: 9, parentId1044: '500', [srcUf]: 'manual' }] } }
        }
        if ((params.filter as Record<string, unknown>).id === 500) {
          return { result: { items: [{ id: 500, opportunity: '100', currencyId: 'BYN' }] } } // payment read
        }
        return { result: { items: [] } } // active rows after deactivation → none
      },
      'crm.item.update': () => ({ result: { item: {} } })
    })
    const res = await reconcileTargetDeletion(1044, 1046, 'invoice', '39', call)
    expect(res).toEqual({ freed: 1, parentsRecomputed: 1, manualParents: 1 })
    const updates = calls.filter(c => c.method === 'crm.item.update')
    // deactivate row 9, recompute «осталось» on 500, set requiresRedistribution on 500
    expect(updates.some(u => u.params.id === 9 && (u.params.fields as Record<string, unknown>)[ufName(1046, DISTRIBUTION_SP_FIELDS.status.postfix)] === 'reverted')).toBe(true)
    expect(updates.some(u => u.params.id === 500 && (u.params.fields as Record<string, unknown>)[needUf] === 100)).toBe(true)
    expect(updates.some(u => u.params.id === 500 && (u.params.fields as Record<string, unknown>)[reqUf] === 'Y')).toBe(true)
  })

  it('auto-only rows do NOT flag requiresRedistribution', async () => {
    const { call, calls } = fakeCall({
      'crm.item.list': (params) => {
        if ((params.filter as Record<string, unknown>)?.[ufName(1046, DISTRIBUTION_SP_FIELDS.targetKind.postfix)]) {
          return { result: { items: [{ id: 9, parentId1044: '500', [srcUf]: 'auto' }] } }
        }
        if ((params.filter as Record<string, unknown>)?.id === 500) return { result: { items: [{ id: 500, opportunity: '100', currencyId: 'BYN' }] } }
        return { result: { items: [] } }
      },
      'crm.item.update': () => ({ result: { item: {} } })
    })
    const res = await reconcileTargetDeletion(1044, 1046, 'invoice', '39', call)
    expect(res.manualParents).toBe(0)
    expect(calls.filter(c => c.method === 'crm.item.update').some(u => (u.params.fields as Record<string, unknown>)[reqUf] !== undefined)).toBe(false)
  })
})

describe('ensurePaymentElement (idempotent by operation marker)', () => {
  const input = { opportunity: 100, currency: 'BYN', marker: 'acc|doc1', companyId: '12' }
  it('creates the carrier when the marker is absent', async () => {
    const { call, calls } = fakeCall({
      'crm.item.list': () => ({ result: { items: [] } }),
      'crm.item.add': () => ({ result: { item: { id: 500 } } })
    })
    expect(await ensurePaymentElement(1044, input, call)).toEqual({ id: '500', created: true })
    expect(calls.some(c => c.method === 'crm.item.add')).toBe(true)
  })
  it('returns the existing carrier (no add) when the marker is present', async () => {
    const { call, calls } = fakeCall({ 'crm.item.list': () => ({ result: { items: [{ id: 77, opportunity: '100', currencyId: 'BYN' }] } }) })
    expect(await ensurePaymentElement(1044, input, call)).toEqual({ id: '77', created: false })
    expect(calls.some(c => c.method === 'crm.item.add')).toBe(false)
  })
  it('throws when add returns no id', async () => {
    const { call } = fakeCall({
      'crm.item.list': () => ({ result: { items: [] } }),
      'crm.item.add': () => ({ result: {} })
    })
    await expect(ensurePaymentElement(1044, input, call)).rejects.toThrow(/no payment element id/)
  })
})

const OP: StatementItem = {
  account: 'BY00', docId: 'D1', direction: 'credit', amount: 100, currency: 'BYN',
  date: '2026-07-01', counterparty: { name: 'X', account: 'BY99' }, purpose: 'по счёту'
} as unknown as StatementItem
const TARGET: AllocationCandidate = { kind: 'invoice', id: '39', amount: 100, currency: 'BYN' }

describe('writeLedgerAllocation (orchestrator)', () => {
  it('ensures the payment element, writes the row, recomputes «осталось»', async () => {
    const { call, calls } = fakeCall({
      // payment marker probe (etid 1044) → none first time; distribution probes → none
      'crm.item.list': () => ({ result: { items: [] } }),
      'crm.item.add': params => (params.entityTypeId === 1044
        ? { result: { item: { id: 500 } } } // payment carrier
        : { result: { item: { id: 900 } } }), // distribution row
      'crm.item.update': () => ({ result: { item: {} } })
    })
    const res = await writeLedgerAllocation(1044, 1046, OP, TARGET, '12', call)
    expect(res.paymentElementId).toBe('500')
    expect(res.rowId).toBe('900')
    expect(res.rowCreated).toBe(true)
    // payment carrier add carried the operation marker (account|docId) + company link
    const payAdd = calls.find(c => c.method === 'crm.item.add' && c.params.entityTypeId === 1044)!
    expect((payAdd.params.fields as Record<string, unknown>).companyId).toBe(12)
    // distribution row add carried the allocation-fact marker (dedup key|kind|id)
    const rowAdd = calls.find(c => c.method === 'crm.item.add' && c.params.entityTypeId === 1046)!
    expect((rowAdd.params.fields as Record<string, unknown>)[ufName(1046, DISTRIBUTION_SP_FIELDS.marker.postfix)]).toBe('BY00|D1|invoice|39')
  })

  it('is idempotent — existing carrier + row are reused, nothing double-added', async () => {
    const { call, calls } = fakeCall({
      'crm.item.list': (params) => {
        if (params.entityTypeId === 1044 && (params.filter as Record<string, unknown>)[ufName(1044, PAYMENT_SP_FIELDS.marker.postfix)]) {
          return { result: { items: [{ id: 500, opportunity: '100', currencyId: 'BYN' }] } } // payment exists
        }
        if ((params.filter as Record<string, unknown>)?.[ufName(1046, DISTRIBUTION_SP_FIELDS.marker.postfix)]) {
          return { result: { items: [{ id: 900 }] } } // row exists
        }
        return { result: { items: [{ id: 900, opportunity: '100', currencyId: 'BYN', [ufName(1046, DISTRIBUTION_SP_FIELDS.status.postfix)]: 'active' }] } } // active rows for recompute
      },
      'crm.item.update': () => ({ result: { item: {} } })
    })
    const res = await writeLedgerAllocation(1044, 1046, OP, TARGET, '12', call)
    expect(res.rowCreated).toBe(false)
    expect(res.remaining).toBe(0) // 100 total − 100 active
    expect(calls.some(c => c.method === 'crm.item.add')).toBe(false)
  })
})
