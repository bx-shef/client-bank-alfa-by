import { describe, expect, it, vi } from 'vitest'
import { routeIdentifier } from '~/utils/identifierDispatch'
import type { IdentifierKind } from '~/utils/purposeMatch'
import type { AllocationCandidate } from '~/utils/allocation'
import type { IntentResolverDeps } from '../server/utils/intentResolver'
import { resolveIntentCandidates } from '../server/utils/intentResolver'

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

  it('payment-number → company pool then exact accountNumber filter', async () => {
    const pool = [pay({ id: 'A', accountNumber: '1/1' }), pay({ id: 'B', accountNumber: '1/2' })]
    const deps = fakeDeps({ pool })
    const r = await resolveIntentCandidates(intent('payment-number', '1/2'), ctx, call, deps)
    expect(r.status).toBe('resolved')
    expect(r.candidates.map(c => c.id)).toEqual(['B']) // only the matching accountNumber
    expect(deps.findCompanyDealPayments).toHaveBeenCalledWith('93', { isNegativeStage: ctx.isNegativeStage }, call)
  })

  it('propagates a REST error thrown by a resolver', async () => {
    const deps = fakeDeps()
    deps.findInvoicesByNumber = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(resolveIntentCandidates(intent('invoice-number', 'СЧ-1'), ctx, call, deps))
      .rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})

describe('resolveIntentCandidates — not-yet-dispatchable kinds', () => {
  const cases: IdentifierKind[] = ['smart-id', 'deal-field', 'smart-field', 'order-id', 'order-number', 'payment-id', 'document-number']
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
  it('passes an undefined isNegativeStage through unchanged (no stage predicate)', async () => {
    const deps = fakeDeps({ invoices: [] })
    await resolveIntentCandidates(intent('invoice-number', 'СЧ-1'), { companyId: '93' }, call, deps)
    expect(deps.findInvoicesByNumber).toHaveBeenCalledWith('СЧ-1', { companyId: '93', isNegativeStage: undefined }, call)
  })
})
