import { describe, expect, it } from 'vitest'
import type { AllocationCandidate } from '~/utils/allocation'
import { readAllocationApplied } from '../server/utils/allocationApplied'

/** A recording fake RestCall: canned responses keyed by method, records every call. */
function fakeCall(responses: Record<string, unknown>) {
  const calls: Array<{ method: string, params: Record<string, unknown> }> = []
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    return (responses[method] ?? { result: null }) as { result?: unknown }
  }
  return { call, calls }
}

const payment = (id: string): AllocationCandidate =>
  ({ kind: 'deal-payment', id, amount: 10, currency: 'BYN', dealId: '99' })
const invoice = (id: string): AllocationCandidate =>
  ({ kind: 'invoice', id, amount: 10, currency: 'BYN' })

describe('readAllocationApplied — deal-payment (paid=Y?)', () => {
  it('returns true when the payment is paid (paid:Y)', async () => {
    const { call, calls } = fakeCall({
      'crm.item.payment.list': { result: [{ id: 42, paid: 'Y', sum: 10, currency: 'BYN' }] }
    })
    expect(await readAllocationApplied(payment('42'), call)).toBe(true)
    expect(calls[0]!.method).toBe('crm.item.payment.list')
    expect(calls[0]!.params).toEqual({ entityId: 99, entityTypeId: 2 })
  })
  it('returns false when the payment is not paid (paid:N)', async () => {
    const { call } = fakeCall({ 'crm.item.payment.list': { result: [{ id: 42, paid: 'N', sum: 10 }] } })
    expect(await readAllocationApplied(payment('42'), call)).toBe(false)
  })
  it('returns false when the target payment is absent from the deal list', async () => {
    const { call } = fakeCall({ 'crm.item.payment.list': { result: [{ id: 7, paid: 'Y' }] } })
    expect(await readAllocationApplied(payment('42'), call)).toBe(false)
  })
  it('matches the payment id as a string (numeric id in the response)', async () => {
    const { call } = fakeCall({ 'crm.item.payment.list': { result: [{ id: '42', paid: 'y' }] } })
    expect(await readAllocationApplied(payment('42'), call)).toBe(true) // case-insensitive Y
  })
  it('returns false WITHOUT a REST call when the candidate has no dealId', async () => {
    const { call, calls } = fakeCall({ 'crm.item.payment.list': { result: [{ id: 42, paid: 'Y' }] } })
    const noDeal: AllocationCandidate = { kind: 'deal-payment', id: '42', amount: 10, currency: 'BYN' }
    expect(await readAllocationApplied(noDeal, call)).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('readAllocationApplied — invoice (on the configured paid stage?)', () => {
  it('returns true when the invoice is on the configured paid stage', async () => {
    const { call, calls } = fakeCall({
      'crm.item.list': { result: { items: [{ id: 7, stageId: 'DT31_11:P' }] } }
    })
    expect(await readAllocationApplied(invoice('7'), call, { invoicePaidStageId: 'DT31_11:P' })).toBe(true)
    expect(calls[0]!.method).toBe('crm.item.list')
    expect(calls[0]!.params).toEqual({ entityTypeId: 31, filter: { id: 7 }, select: ['id', 'stageId'] })
  })
  it('returns false when the invoice is on a DIFFERENT stage', async () => {
    const { call } = fakeCall({ 'crm.item.list': { result: { items: [{ id: 7, stageId: 'DT31_11:N' }] } } })
    expect(await readAllocationApplied(invoice('7'), call, { invoicePaidStageId: 'DT31_11:P' })).toBe(false)
  })
  it('returns false WITHOUT a REST call when no paid stage is configured', async () => {
    const { call, calls } = fakeCall({ 'crm.item.list': { result: { items: [{ id: 7, stageId: 'DT31_11:P' }] } } })
    expect(await readAllocationApplied(invoice('7'), call, {})).toBe(false)
    expect(calls).toHaveLength(0)
  })
  it('returns false when the invoice id is not in the response', async () => {
    const { call } = fakeCall({ 'crm.item.list': { result: { items: [] } } })
    expect(await readAllocationApplied(invoice('7'), call, { invoicePaidStageId: 'DT31_11:P' })).toBe(false)
  })
})

describe('readAllocationApplied — trigger targets have no readable applied-state', () => {
  it('deal → false WITHOUT a REST call', async () => {
    const { call, calls } = fakeCall({})
    expect(await readAllocationApplied({ kind: 'deal', id: '5', amount: 10, currency: 'BYN' }, call, { invoicePaidStageId: 'X' })).toBe(false)
    expect(calls).toHaveLength(0)
  })
  it('smart-process → false WITHOUT a REST call', async () => {
    const { call, calls } = fakeCall({})
    expect(await readAllocationApplied({ kind: 'smart-process', id: '5', amount: 10, currency: 'BYN', entityTypeId: 1044 }, call)).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
