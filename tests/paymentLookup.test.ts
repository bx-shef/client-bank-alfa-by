import { describe, expect, it, vi } from 'vitest'
import { DEAL_ENTITY_TYPE_ID, extractPayments, findDealPayments, paymentListParams } from '../server/utils/paymentLookup'

// Deal-payment resolver (#109). Field names/response shape confirmed live against a
// seeded deal: payments sit DIRECTLY in `result` (array), each `{id, accountNumber,
// paid, sum, currency, …}`. A settled payment (paid='Y') is not an allocation target.

const resp = (payments: unknown[]) => ({ result: payments })
const pay = (over: Record<string, unknown> = {}) => ({
  id: 3, accountNumber: '1/2', paid: 'N', sum: 1200, currency: 'BYN', paySystemId: 11, ...over
})

describe('paymentListParams', () => {
  it('scopes to one deal via entityId + entityTypeId (2 = deal)', () => {
    expect(paymentListParams(33)).toEqual({ entityId: 33, entityTypeId: 2 })
    expect(DEAL_ENTITY_TYPE_ID).toBe(2)
  })
  it('allows a custom entityTypeId (e.g. a smart process that owns payments)', () => {
    expect(paymentListParams(33, 1032)).toEqual({ entityId: 33, entityTypeId: 1032 })
  })
})

describe('extractPayments', () => {
  it('reads the array directly from result (not result.items), tolerating bad shapes', () => {
    expect(extractPayments(resp([pay({ id: 7 })]))[0]!.id).toBe(7)
    expect(extractPayments(resp([]))).toEqual([])
    expect(extractPayments({})).toEqual([])
    expect(extractPayments({ result: { items: [pay()] } })).toEqual([]) // NOT result.items
  })
})

describe('findDealPayments', () => {
  it('maps an unpaid payment to a deal-payment candidate (id, amount=sum, currency, dealId)', async () => {
    const call = vi.fn(async () => resp([pay({ id: 3, sum: 1200, currency: 'BYN', paid: 'N' })]))
    expect(await findDealPayments('33', {}, call))
      .toEqual([{ kind: 'deal-payment', id: '3', amount: 1200, currency: 'BYN', dealId: '33' }])
    expect(call.mock.calls[0]![0]).toBe('crm.item.payment.list')
    expect(call.mock.calls[0]![1]).toEqual({ entityId: 33, entityTypeId: 2 })
  })

  it('skips a settled payment (paid=Y) by default', async () => {
    const call = vi.fn(async () => resp([pay({ id: 3, paid: 'Y' })]))
    expect(await findDealPayments('33', {}, call)).toEqual([])
  })

  it('keeps settled payments when includePaid is set', async () => {
    const call = vi.fn(async () => resp([pay({ id: 3, paid: 'Y', sum: 1200 })]))
    const out = await findDealPayments('33', { includePaid: true }, call)
    expect(out).toHaveLength(1)
    expect(out[0]!.amount).toBe(1200)
  })

  it('filters within a mixed list (real shape: paid 0-sum + unpaid target)', async () => {
    const call = vi.fn(async () => resp([
      pay({ id: 1, accountNumber: '1/1', sum: 0, paid: 'Y' }),
      pay({ id: 5, accountNumber: '1/3', sum: 1200, paid: 'N' })
    ]))
    expect((await findDealPayments('33', {}, call)).map(c => c.id)).toEqual(['5'])
  })

  it('skips a payment with a non-finite sum or an empty id', async () => {
    const nonFinite = vi.fn(async () => resp([pay({ id: 3, sum: undefined })]))
    expect(await findDealPayments('33', {}, nonFinite)).toEqual([])
    const noId = vi.fn(async () => resp([pay({ id: undefined, sum: 1200 })]))
    expect(await findDealPayments('33', {}, noId)).toEqual([])
  })

  it('returns every unpaid payment as its own candidate', async () => {
    const call = vi.fn(async () => resp([
      pay({ id: 3, sum: 1200, paid: 'N' }),
      pay({ id: 5, sum: 300, paid: 'N' })
    ]))
    expect((await findDealPayments('33', {}, call)).map(c => ({ id: c.id, amount: c.amount })))
      .toEqual([{ id: '3', amount: 1200 }, { id: '5', amount: 300 }])
  })

  it('treats paid case-insensitively (paid="y" is settled)', async () => {
    const call = vi.fn(async () => resp([pay({ id: 3, paid: 'y' })]))
    expect(await findDealPayments('33', {}, call)).toEqual([])
  })

  it('trims the dealId — the query id and the candidate dealId are both clean', async () => {
    const call = vi.fn(async () => resp([pay({ id: 3, sum: 1200 })]))
    const out = await findDealPayments('  33  ', {}, call)
    expect(call.mock.calls[0]![1]).toEqual({ entityId: 33, entityTypeId: 2 })
    expect(out[0]!.dealId).toBe('33')
  })

  it('parses a string sum and defaults a missing currency to empty', async () => {
    const call = vi.fn(async () => resp([pay({ sum: '250.5', currency: undefined })]))
    const out = await findDealPayments('33', {}, call)
    expect(out[0]!.amount).toBeCloseTo(250.5, 2)
    expect(out[0]!.currency).toBe('')
  })

  it('returns [] without a REST call for a blank / non-numeric / non-positive dealId', async () => {
    const call = vi.fn(async () => resp([pay()]))
    expect(await findDealPayments('  ', {}, call)).toEqual([])
    expect(await findDealPayments('abc', {}, call)).toEqual([])
    expect(await findDealPayments('0', {}, call)).toEqual([])
    expect(await findDealPayments('-4', {}, call)).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('propagates a REST error thrown by call', async () => {
    const call = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(findDealPayments('33', {}, call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
