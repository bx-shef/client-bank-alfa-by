import { describe, expect, it, vi } from 'vitest'
import { IDENTIFIER_ROUTES, routeIdentifier } from '~/utils/identifierDispatch'
import type { IdentifierKind } from '~/utils/purposeMatch'
import type { AllocationCandidate } from '~/utils/allocation'
import type { IntentResolverDeps } from '../server/utils/intentResolver'
import { resolveIntentCandidates, resolveIntentsForOp } from '../server/utils/intentResolver'

// Pure dispatch recognized-intent → entity resolver (#109). Resolvers are faked, so
// the tests assert the ROUTING decision (which resolver, which args) not the REST.

const intent = (kind: IdentifierKind, value: string) => ({ kind, value, route: routeIdentifier(kind) })

const inv = (over: Partial<AllocationCandidate> = {}): AllocationCandidate =>
  ({ kind: 'invoice', id: '1', amount: 100, currency: 'BYN', ...over })
const pay = (over: Partial<AllocationCandidate> = {}): AllocationCandidate =>
  ({ kind: 'deal-payment', id: '1', amount: 100, currency: 'BYN', ...over })

/** Fake resolvers; each records its call and returns the given fixture. */
function fakeDeps(over: Partial<{ invoices: AllocationCandidate[], byId: AllocationCandidate | null, pool: AllocationCandidate[] }> = {}) {
  const deps: IntentResolverDeps = {
    findInvoicesByNumber: vi.fn(async () => over.invoices ?? []),
    findCandidateById: vi.fn(async () => over.byId ?? null),
    findCompanyDealPayments: vi.fn(async () => over.pool ?? [])
  }
  return deps
}

const call = (async () => ({})) as never // never used by the fakes; identity token
const ctx = { companyId: '93', isNegativeStage: (s: string) => s === 'LOSE' }

describe('resolveIntentCandidates — supported strategies', () => {
  it('invoice-number → findInvoicesByNumber(value, {companyId, isNegativeStage})', async () => {
    const deps = fakeDeps({ invoices: [inv({ id: '7' })] })
    const r = await resolveIntentCandidates(intent('invoice-number', 'СЧ-1234'), ctx, call, deps)
    expect(r).toEqual({ kind: 'invoice-number', value: 'СЧ-1234', status: 'resolved', candidates: [inv({ id: '7' })] })
    expect(deps.findInvoicesByNumber).toHaveBeenCalledWith('СЧ-1234', { companyId: '93', isNegativeStage: ctx.isNegativeStage }, call)
  })

  it('invoice-id → findCandidateById(invoice, 31, value); found → single candidate', async () => {
    const deps = fakeDeps({ byId: inv({ id: '42' }) })
    const r = await resolveIntentCandidates(intent('invoice-id', '42'), ctx, call, deps)
    expect(r.status).toBe('resolved')
    expect(r.candidates).toEqual([inv({ id: '42' })])
    expect(deps.findCandidateById).toHaveBeenCalledWith('invoice', 31, '42', { companyId: '93', isNegativeStage: ctx.isNegativeStage }, call)
  })

  it('deal-id → findCandidateById(deal, 2, value); not found → []', async () => {
    const deps = fakeDeps({ byId: null })
    const r = await resolveIntentCandidates(intent('deal-id', '55'), ctx, call, deps)
    expect(r).toEqual({ kind: 'deal-id', value: '55', status: 'resolved', candidates: [] })
    expect(deps.findCandidateById).toHaveBeenCalledWith('deal', 2, '55', { companyId: '93', isNegativeStage: ctx.isNegativeStage }, call)
  })

  it('invoice-number passes ALL found candidates through unchanged (no dedup/slice)', async () => {
    const many = [inv({ id: '7' }), inv({ id: '8' }), inv({ id: '9' })]
    const deps = fakeDeps({ invoices: many })
    const r = await resolveIntentCandidates(intent('invoice-number', 'СЧ-1'), ctx, call, deps)
    expect(r.candidates).toEqual(many) // the dispatcher is a passthrough; ambiguity is resolveAllocation's job
  })

  it('payment-number → company pool then exact accountNumber filter', async () => {
    const pool = [pay({ id: 'A', accountNumber: '1/1' }), pay({ id: 'B', accountNumber: '1/2' })]
    const deps = fakeDeps({ pool })
    const r = await resolveIntentCandidates(intent('payment-number', '1/2'), ctx, call, deps)
    expect(r.status).toBe('resolved')
    expect(r.candidates.map(c => c.id)).toEqual(['B']) // only the matching accountNumber
    expect(deps.findCompanyDealPayments).toHaveBeenCalledWith('93', { isNegativeStage: ctx.isNegativeStage }, call)
  })

  it('payment-number with no accountNumber match → resolved with [] (not unsupported)', async () => {
    const deps = fakeDeps({ pool: [pay({ id: 'A', accountNumber: '1/1' })] })
    const r = await resolveIntentCandidates(intent('payment-number', '9/9'), ctx, call, deps)
    expect(r).toEqual({ kind: 'payment-number', value: '9/9', status: 'resolved', candidates: [] })
  })

  it('order-number → company pool then order-PREFIX filter (matches every seq of the order, #172)', async () => {
    const pool = [
      pay({ id: 'A', accountNumber: '1/1' }), pay({ id: 'B', accountNumber: '1/2' }), pay({ id: 'C', accountNumber: '2/1' })
    ]
    const deps = fakeDeps({ pool })
    const r = await resolveIntentCandidates(intent('order-number', '1'), ctx, call, deps)
    expect(r.status).toBe('resolved')
    expect(r.candidates.map(c => c.id)).toEqual(['A', 'B']) // both payments of order «1», not «2/1»
    expect(deps.findCompanyDealPayments).toHaveBeenCalledWith('93', { isNegativeStage: ctx.isNegativeStage }, call)
  })

  it('order-number does NOT match a longer order number sharing the prefix digits (10 ≠ 1)', async () => {
    const deps = fakeDeps({ pool: [pay({ id: 'A', accountNumber: '10/1' })] })
    const r = await resolveIntentCandidates(intent('order-number', '1'), ctx, call, deps)
    expect(r).toEqual({ kind: 'order-number', value: '1', status: 'resolved', candidates: [] })
  })

  it('order-id stays unsupported (needs sale scope to map id→order→payment, #172)', async () => {
    const deps = fakeDeps({ pool: [pay({ id: 'A', accountNumber: '1/1' })] })
    const r = await resolveIntentCandidates(intent('order-id', '1'), ctx, call, deps)
    expect(r.status).toBe('unsupported')
    expect(deps.findCompanyDealPayments).not.toHaveBeenCalled()
  })

  it('propagates a REST error from every resolved path (invoice-number / by-id / payment-number)', async () => {
    const boom = () => vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    const invDeps = fakeDeps()
    invDeps.findInvoicesByNumber = boom()
    await expect(resolveIntentCandidates(intent('invoice-number', 'СЧ-1'), ctx, call, invDeps)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')

    const idDeps = fakeDeps()
    idDeps.findCandidateById = boom()
    await expect(resolveIntentCandidates(intent('deal-id', '55'), ctx, call, idDeps)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')

    const payDeps = fakeDeps()
    payDeps.findCompanyDealPayments = boom()
    await expect(resolveIntentCandidates(intent('payment-number', '1/1'), ctx, call, payDeps)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})

describe('resolveIntentCandidates — not-yet-dispatchable kinds', () => {
  const cases: IdentifierKind[] = ['smart-id', 'deal-field', 'smart-field', 'order-id', 'payment-id', 'document-number']
  for (const kind of cases) {
    it(`${kind} → unsupported, no resolver called, [] candidates, reason set`, async () => {
      const deps = fakeDeps({ invoices: [inv()], byId: inv(), pool: [pay()] })
      const r = await resolveIntentCandidates(intent(kind, 'X'), ctx, call, deps)
      expect(r.status).toBe('unsupported')
      expect(r.candidates).toEqual([])
      expect(r.reason).toBeTruthy()
      expect(deps.findInvoicesByNumber).not.toHaveBeenCalled()
      expect(deps.findCandidateById).not.toHaveBeenCalled()
      expect(deps.findCompanyDealPayments).not.toHaveBeenCalled()
    })
  }
})

describe('resolveIntentCandidates — context threading', () => {
  it('passes an undefined isNegativeStage through unchanged on every resolved path', async () => {
    const deps = fakeDeps()
    const noStage = { companyId: '93' }
    await resolveIntentCandidates(intent('invoice-number', 'СЧ-1'), noStage, call, deps)
    await resolveIntentCandidates(intent('deal-id', '55'), noStage, call, deps)
    await resolveIntentCandidates(intent('payment-number', '1/1'), noStage, call, deps)
    expect(deps.findInvoicesByNumber).toHaveBeenCalledWith('СЧ-1', { companyId: '93', isNegativeStage: undefined }, call)
    expect(deps.findCandidateById).toHaveBeenCalledWith('deal', 2, '55', { companyId: '93', isNegativeStage: undefined }, call)
    expect(deps.findCompanyDealPayments).toHaveBeenCalledWith('93', { isNegativeStage: undefined }, call)
  })
})

describe('resolveIntentCandidates — exhaustiveness & route alignment', () => {
  const allKinds = Object.keys(IDENTIFIER_ROUTES) as IdentifierKind[]

  it('handles EVERY IdentifierKind (a missing switch case → undefined resolution, caught here)', async () => {
    // server/** is now covered by vue-tsc (#187 fixed), so a missing case is a compile
    // error (TS2366). This test is belt-and-suspenders — it catches an exhaustiveness
    // regression at test time (and without a full typecheck run).
    const deps = fakeDeps({ invoices: [inv()], byId: inv(), pool: [pay()] })
    for (const kind of allKinds) {
      const r = await resolveIntentCandidates(intent(kind, 'X'), ctx, call, deps)
      expect(r, `kind "${kind}" is unhandled by the switch`).toBeDefined()
      expect(['resolved', 'unsupported']).toContain(r.status)
      expect(r.kind).toBe(kind)
    }
  })

  it('the dispatched kinds carry the strategy the route table declares (layers stay aligned)', () => {
    expect(routeIdentifier('invoice-number').strategy).toBe('by-number')
    expect(routeIdentifier('invoice-id').strategy).toBe('by-id')
    expect(routeIdentifier('deal-id').strategy).toBe('by-id')
    expect(routeIdentifier('payment-number').strategy).toBe('by-account-number')
  })
})

describe('resolveIntentsForOp — batch, pool fetched once (#191)', () => {
  it('fetches the deal-payment pool ONCE for several payment-number intents, filters each', async () => {
    const deps = fakeDeps({ pool: [pay({ id: 'A', accountNumber: '1/1' }), pay({ id: 'B', accountNumber: '1/2' })] })
    const out = await resolveIntentsForOp(
      [intent('payment-number', '1/1'), intent('payment-number', '1/2')], ctx, call, deps
    )
    expect(deps.findCompanyDealPayments).toHaveBeenCalledTimes(1) // pooled, not per value
    expect(out.map(r => r.candidates.map(c => c.id))).toEqual([['A'], ['B']]) // each filtered by its own value
  })

  it('filters each payment-number against the SHARED pool — a miss yields resolved []', async () => {
    const deps = fakeDeps({ pool: [pay({ id: 'A', accountNumber: '1/1' })] }) // only 1/1 in the pool
    const out = await resolveIntentsForOp(
      [intent('payment-number', '1/1'), intent('payment-number', '9/9')], ctx, call, deps
    )
    expect(deps.findCompanyDealPayments).toHaveBeenCalledTimes(1)
    expect(out.map(r => [r.status, r.candidates.map(c => c.id)])).toEqual([
      ['resolved', ['A']], ['resolved', []] // hit vs miss, both resolved (not unsupported)
    ])
  })

  it('does NOT fetch the pool when no payment-number intent is present', async () => {
    const deps = fakeDeps({ invoices: [inv({ id: '7' })] })
    const out = await resolveIntentsForOp([intent('invoice-number', 'СЧ-1'), intent('deal-id', '5')], ctx, call, deps)
    expect(deps.findCompanyDealPayments).not.toHaveBeenCalled()
    expect(out.map(r => r.kind)).toEqual(['invoice-number', 'deal-id'])
  })

  it('order-number and payment-number SHARE the single pool fetch (both filter it, #172/#191)', async () => {
    const deps = fakeDeps({ pool: [pay({ id: 'A', accountNumber: '1/1' }), pay({ id: 'B', accountNumber: '2/1' })] })
    const out = await resolveIntentsForOp(
      [intent('order-number', '1'), intent('payment-number', '2/1')], ctx, call, deps
    )
    expect(deps.findCompanyDealPayments).toHaveBeenCalledTimes(1) // one fetch feeds both
    expect(out.map(r => [r.kind, r.candidates.map(c => c.id)])).toEqual([
      ['order-number', ['A']], ['payment-number', ['B']]
    ])
  })

  it('fetches the pool for an order-number-only batch (no payment-number present)', async () => {
    const deps = fakeDeps({ pool: [pay({ id: 'A', accountNumber: '1/1' })] })
    await resolveIntentsForOp([intent('order-number', '1')], ctx, call, deps)
    expect(deps.findCompanyDealPayments).toHaveBeenCalledTimes(1)
  })

  it('mixes pooled payment-number with other kinds, preserving order', async () => {
    const deps = fakeDeps({ invoices: [inv({ id: '7' })], pool: [pay({ id: 'A', accountNumber: '1/1' })] })
    const out = await resolveIntentsForOp(
      [intent('invoice-number', 'СЧ-1'), intent('payment-number', '1/1'), intent('smart-id', 'X')], ctx, call, deps
    )
    expect(deps.findCompanyDealPayments).toHaveBeenCalledTimes(1)
    expect(deps.findInvoicesByNumber).toHaveBeenCalledTimes(1)
    expect(out.map(r => [r.kind, r.status, r.candidates.length])).toEqual([
      ['invoice-number', 'resolved', 1], ['payment-number', 'resolved', 1], ['smart-id', 'unsupported', 0]
    ])
  })

  it('propagates a REST error from the pooled lookup', async () => {
    const deps = fakeDeps()
    deps.findCompanyDealPayments = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(resolveIntentsForOp([intent('payment-number', '1/1')], ctx, call, deps)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })

  it('returns [] for no intents (no lookups)', async () => {
    const deps = fakeDeps()
    expect(await resolveIntentsForOp([], ctx, call, deps)).toEqual([])
    expect(deps.findCompanyDealPayments).not.toHaveBeenCalled()
  })
})
