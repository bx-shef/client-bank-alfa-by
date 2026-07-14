import { describe, expect, it, vi } from 'vitest'
import { extractSalePayments, findOrderPaymentIds, orderPaymentsParams } from '../server/utils/saleLookup'

// order-id → its payment record ids via sale.payment.list (#172, scope `sale`).
// Field names confirmed live: result.payments[] with { id, orderId, accountNumber }.

const resp = (payments: unknown[]) => ({ result: { payments } })

describe('orderPaymentsParams', () => {
  it('filters by orderId and selects only the ids we intersect with the pool', () => {
    expect(orderPaymentsParams('1')).toEqual({ filter: { orderId: '1' }, select: ['id', 'orderId'] })
  })
})

describe('extractSalePayments', () => {
  it('pulls result.payments, tolerating a missing/!array shape', () => {
    expect(extractSalePayments(resp([{ id: 5 }]))).toEqual([{ id: 5 }])
    expect(extractSalePayments({})).toEqual([])
    expect(extractSalePayments({ result: { payments: 'x' } })).toEqual([])
  })
})

describe('findOrderPaymentIds', () => {
  it('returns the payment record ids of the order (as strings)', async () => {
    const call = vi.fn(async () => resp([{ id: 5, orderId: 1 }, { id: 8, orderId: 1 }]))
    expect(await findOrderPaymentIds('1', call)).toEqual(['5', '8'])
    expect(call.mock.calls[0]![0]).toBe('sale.payment.list')
    expect(call.mock.calls[0]![1]).toMatchObject({ filter: { orderId: '1' } })
  })

  it('blank orderId → [] WITHOUT a REST call (an empty filter would list all payments)', async () => {
    const call = vi.fn(async () => resp([{ id: 5, orderId: 1 }]))
    expect(await findOrderPaymentIds('   ', call)).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('guards against a portal that ignores the orderId filter (echo mismatch dropped)', async () => {
    // Row for order 2 must not leak into a query for order 1 if the filter is ignored.
    const call = vi.fn(async () => resp([{ id: 5, orderId: 1 }, { id: 9, orderId: 2 }]))
    expect(await findOrderPaymentIds('1', call)).toEqual(['5'])
  })

  it('skips rows with a blank/absent id', async () => {
    const call = vi.fn(async () => resp([{ id: '', orderId: 1 }, { orderId: 1 }, { id: 7, orderId: 1 }]))
    expect(await findOrderPaymentIds('1', call)).toEqual(['7'])
  })

  it('propagates a transport error', async () => {
    const call = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(findOrderPaymentIds('1', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
