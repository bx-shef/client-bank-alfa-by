import { describe, expect, it, vi } from 'vitest'
import {
  companyDealsParams,
  DEAL_ENTITY_TYPE_ID,
  dealListTotal,
  extractDealRows,
  extractPayments,
  findCompanyDealPayments,
  findDealPayments,
  MAX_DEAL_PAGES,
  paymentListParams
} from '../server/utils/paymentLookup'

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
  it('maps an unpaid payment to a deal-payment candidate (id, amount=sum, currency, dealId, accountNumber)', async () => {
    const call = vi.fn(async () => resp([pay({ id: 3, accountNumber: '1/2', sum: 1200, currency: 'BYN', paid: 'N' })]))
    expect(await findDealPayments('33', {}, call))
      .toEqual([{ kind: 'deal-payment', id: '3', amount: 1200, currency: 'BYN', dealId: '33', accountNumber: '1/2' }])
    expect(call.mock.calls[0]![0]).toBe('crm.item.payment.list')
    expect(call.mock.calls[0]![1]).toEqual({ entityId: 33, entityTypeId: 2 })
  })

  it('omits accountNumber when the payment has none (keeps the field optional)', async () => {
    const call = vi.fn(async () => resp([pay({ id: 3, accountNumber: undefined })]))
    const out = await findDealPayments('33', {}, call)
    expect(out[0]).not.toHaveProperty('accountNumber')
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

describe('companyDealsParams / extractDealRows / dealListTotal', () => {
  it('filters deals by companyId (IDOR scope), selects id/stage, starts at offset 0', () => {
    expect(companyDealsParams('93')).toEqual({
      entityTypeId: 2,
      filter: { companyId: '93' },
      select: ['id', 'stageId'],
      start: 0
    })
  })
  it('carries an explicit pagination offset', () => {
    expect(companyDealsParams('93', 50)).toMatchObject({ start: 50, filter: { companyId: '93' } })
  })
  it('reads result.items (deal list), tolerating bad shapes', () => {
    expect(extractDealRows({ result: { items: [{ id: 33 }] } })[0]!.id).toBe(33)
    expect(extractDealRows({ result: { items: 'x' } })).toEqual([])
    expect(extractDealRows({})).toEqual([])
  })
  it('reads the top-level total (NaN when absent → single-page fallback)', () => {
    expect(dealListTotal({ result: { items: [] }, total: 3 })).toBe(3)
    expect(Number.isNaN(dealListTotal({ result: { items: [] } }))).toBe(true)
  })
})

describe('findCompanyDealPayments', () => {
  // Dispatch mock: crm.item.list → the company's deals, crm.item.payment.list →
  // that deal's payments keyed by entityId.
  const portal = (deals: unknown[], paymentsByDeal: Record<number, unknown[]>) =>
    vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'crm.item.list') return { result: { items: deals } }
      if (method === 'crm.item.payment.list') return { result: paymentsByDeal[params.entityId as number] ?? [] }
      throw new Error(`unexpected method ${method}`)
    })
  const pay = (over: Record<string, unknown> = {}) => ({ id: 3, accountNumber: '1/2', paid: 'N', sum: 1200, currency: 'BYN', ...over })

  it('aggregates payments across the company deals, tagging each with its dealId', async () => {
    const call = portal(
      [{ id: 33, stageId: 'C5:NEW' }, { id: 41, stageId: 'NEW' }],
      { 33: [pay({ id: 3, sum: 1200 })], 41: [pay({ id: 8, sum: 500 })] }
    )
    const out = await findCompanyDealPayments('93', {}, call)
    expect(out).toEqual([
      { kind: 'deal-payment', id: '3', amount: 1200, currency: 'BYN', dealId: '33', accountNumber: '1/2' },
      { kind: 'deal-payment', id: '8', amount: 500, currency: 'BYN', dealId: '41', accountNumber: '1/2' }
    ])
    expect(call.mock.calls[0]![1]).toMatchObject({ entityTypeId: 2, filter: { companyId: '93' } })
  })

  it('flattens several payments of one deal and tolerates a deal with none', async () => {
    const call = portal(
      [{ id: 33, stageId: 'NEW' }, { id: 41, stageId: 'NEW' }],
      { 33: [pay({ id: 3, sum: 1200 }), pay({ id: 4, sum: 300 })], 41: [] } // deal 41 has no payments
    )
    const out = await findCompanyDealPayments('93', {}, call)
    expect(out.map(c => ({ id: c.id, dealId: c.dealId }))).toEqual([
      { id: '3', dealId: '33' },
      { id: '4', dealId: '33' }
    ])
  })

  it('feeds an empty string to the stage predicate when a deal has no stageId', async () => {
    const seen: string[] = []
    const call = portal([{ id: 33, stageId: undefined }], { 33: [pay()] })
    await findCompanyDealPayments('93', { isNegativeStage: (s) => {
      seen.push(s)
      return false
    } }, call)
    expect(seen).toEqual([''])
  })

  it('returns [] for a company with no deals (payment.list never called)', async () => {
    const call = portal([], {})
    expect(await findCompanyDealPayments('93', {}, call)).toEqual([])
    expect(call.mock.calls.every(c => c[0] === 'crm.item.list')).toBe(true)
  })

  it('skips a negative-stage deal WITHOUT listing its payments', async () => {
    const call = portal(
      [{ id: 33, stageId: 'C5:LOSE' }, { id: 41, stageId: 'NEW' }],
      { 33: [pay({ id: 3 })], 41: [pay({ id: 8, sum: 500 })] }
    )
    const isNegativeStage = (s: string) => s === 'C5:LOSE'
    const out = await findCompanyDealPayments('93', { isNegativeStage }, call)
    expect(out.map(c => c.dealId)).toEqual(['41'])
    // payment.list called only for deal 41, never for the lost deal 33
    const paymentCalls = call.mock.calls.filter(c => c[0] === 'crm.item.payment.list')
    expect(paymentCalls.map(c => (c[1] as { entityId: number }).entityId)).toEqual([41])
  })

  it('passes includePaid through to each deal', async () => {
    const call = portal([{ id: 33, stageId: 'NEW' }], { 33: [pay({ id: 3, paid: 'Y', sum: 1200 })] })
    expect(await findCompanyDealPayments('93', {}, call)).toEqual([]) // paid dropped
    expect(await findCompanyDealPayments('93', { includePaid: true }, call)).toHaveLength(1)
  })

  it('skips a deal row with an empty id', async () => {
    const call = portal([{ id: undefined, stageId: 'NEW' }], {})
    expect(await findCompanyDealPayments('93', {}, call)).toEqual([])
  })

  it('returns [] without a REST call for a blank companyId', async () => {
    const call = portal([{ id: 33, stageId: 'NEW' }], { 33: [pay()] })
    expect(await findCompanyDealPayments('  ', {}, call)).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('propagates a REST error from the deal list', async () => {
    const call = vi.fn(async () => {
      throw new Error('ACCESS_DENIED')
    })
    await expect(findCompanyDealPayments('93', {}, call)).rejects.toThrow('ACCESS_DENIED')
  })

  it('propagates a REST error thrown by a per-deal payment.list (N+1 inner call)', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'crm.item.list') return { result: { items: [{ id: 33, stageId: 'NEW' }] } }
      throw new Error('QUERY_LIMIT_EXCEEDED') // crm.item.payment.list fails
    })
    await expect(findCompanyDealPayments('93', {}, call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })

  // --- Pagination (#191): the deal list is single-page (max 50); a company with more
  // deals must be paged by `start`, else the overflow pool is silently lost (→ manual).
  // Paged dispatch mock: crm.item.list slices `allDeals` by start/pageSize and reports a
  // top-level `total`; crm.item.payment.list keys payments by entityId.
  const pagedPortal = (allDeals: Array<{ id: number, stageId?: string }>, paymentsByDeal: Record<number, unknown[]>, pageSize: number) =>
    vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'crm.item.list') {
        const start = Number(params.start) || 0
        return { result: { items: allDeals.slice(start, start + pageSize) }, total: allDeals.length }
      }
      if (method === 'crm.item.payment.list') return { result: paymentsByDeal[params.entityId as number] ?? [] }
      throw new Error(`unexpected method ${method}`)
    })

  it('pages through deals beyond the first page and aggregates the whole pool', async () => {
    const deals = [{ id: 33, stageId: 'NEW' }, { id: 41, stageId: 'NEW' }, { id: 52, stageId: 'NEW' }]
    const call = pagedPortal(deals, { 33: [pay({ id: 3 })], 41: [pay({ id: 8 })], 52: [pay({ id: 9 })] }, 2)
    const out = await findCompanyDealPayments('93', {}, call)
    // All three deals' payments collected — the deal on page 2 (id 52) is NOT lost.
    expect(out.map(c => c.dealId)).toEqual(['33', '41', '52'])
    const listCalls = call.mock.calls.filter(c => c[0] === 'crm.item.list')
    expect(listCalls.map(c => (c[1] as { start: number }).start)).toEqual([0, 2]) // two pages: start 0, 2
  })

  it('stops paging once total is collected (no extra empty page)', async () => {
    const deals = [{ id: 33, stageId: 'NEW' }, { id: 41, stageId: 'NEW' }]
    const call = pagedPortal(deals, { 33: [pay({ id: 3 })], 41: [pay({ id: 8 })] }, 2)
    await findCompanyDealPayments('93', {}, call)
    // total=2 collected on page 1 (start 0) → no second list call.
    expect(call.mock.calls.filter(c => c[0] === 'crm.item.list')).toHaveLength(1)
  })

  it('bounds a runaway portal (total never satisfied) at MAX_DEAL_PAGES', async () => {
    // Pathological portal: always returns a full page and an inflated total → the cap
    // is the only thing that ends the loop.
    const call = vi.fn(async (method: string) => {
      if (method === 'crm.item.list') return { result: { items: [{ id: 33, stageId: 'NEW' }] }, total: 999999 }
      return { result: [] } // no payments
    })
    await findCompanyDealPayments('93', {}, call)
    expect(call.mock.calls.filter(c => c[0] === 'crm.item.list')).toHaveLength(MAX_DEAL_PAGES)
  })

  it('keeps single-page behaviour when the response carries no total (stub fallback)', async () => {
    // The existing portal() mock returns no `total` → exactly one list call, as before.
    const call = portal([{ id: 33, stageId: 'NEW' }], { 33: [pay({ id: 3 })] })
    const out = await findCompanyDealPayments('93', {}, call)
    expect(out).toHaveLength(1)
    expect(call.mock.calls.filter(c => c[0] === 'crm.item.list')).toHaveLength(1)
  })
})
