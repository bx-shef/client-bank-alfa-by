import { describe, expect, it, vi } from 'vitest'
import { IDENTIFIER_ROUTES, routeIdentifier } from '~/utils/identifierDispatch'
import type { IdentifierKind } from '~/utils/purposeMatch'
import type { AllocationCandidate } from '~/utils/allocation'
import type { IntentResolverDeps } from '../server/utils/intentResolver'
import { parseConfiguredEntityTypeId, resolveIntentCandidates, resolveIntentsForOp } from '../server/utils/intentResolver'

// Pure dispatch recognized-intent → entity resolver (#109). Resolvers are faked, so
// the tests assert the ROUTING decision (which resolver, which args) not the REST.

const intent = (kind: IdentifierKind, value: string) => ({ kind, value, route: routeIdentifier(kind) })

const inv = (over: Partial<AllocationCandidate> = {}): AllocationCandidate =>
  ({ kind: 'invoice', id: '1', amount: 100, currency: 'BYN', ...over })
const pay = (over: Partial<AllocationCandidate> = {}): AllocationCandidate =>
  ({ kind: 'deal-payment', id: '1', amount: 100, currency: 'BYN', ...over })

/** Fake resolvers; each records its call and returns the given fixture. */
function fakeDeps(over: Partial<{ invoices: AllocationCandidate[], byId: AllocationCandidate | null, byField: AllocationCandidate | null, pool: AllocationCandidate[], orderPaymentIds: string[] }> = {}) {
  const deps: IntentResolverDeps = {
    findInvoicesByNumber: vi.fn(async () => over.invoices ?? []),
    findCandidateById: vi.fn(async () => over.byId ?? null),
    findCandidateByField: vi.fn(async () => over.byField ?? null),
    findCompanyDealPayments: vi.fn(async () => over.pool ?? []),
    findOrderPaymentIds: vi.fn(async () => over.orderPaymentIds ?? [])
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

  it('order-id → sale.payment.list ids INTERSECTED with the company pool (IDOR-safe, #172)', async () => {
    // order 1 has payments 5 (in company pool) and 99 (NOT in pool → dropped by the intersection).
    const deps = fakeDeps({ pool: [pay({ id: '5', accountNumber: '1/1' }), pay({ id: '7', accountNumber: '3/1' })], orderPaymentIds: ['5', '99'] })
    const r = await resolveIntentCandidates(intent('order-id', '1'), ctx, call, deps)
    expect(r.status).toBe('resolved')
    expect(r.candidates.map(c => c.id)).toEqual(['5']) // 99 is not in the company pool → excluded
    expect(deps.findCompanyDealPayments).toHaveBeenCalledWith('93', { isNegativeStage: ctx.isNegativeStage }, call)
    expect(deps.findOrderPaymentIds).toHaveBeenCalledWith('1', call)
  })

  it('order-id whose payments are all outside the company pool → resolved [] (IDOR-safe)', async () => {
    const deps = fakeDeps({ pool: [pay({ id: '5', accountNumber: '1/1' })], orderPaymentIds: ['99'] })
    const r = await resolveIntentCandidates(intent('order-id', '9'), ctx, call, deps)
    expect(r).toEqual({ kind: 'order-id', value: '9', status: 'resolved', candidates: [] })
  })

  // #242: a PREFIXED mask (`ЗАК-dddd`, `BOPC-ddd/dd`) makes the recognizer return the prefix
  // (`ЗАК-6001`), but deal-payment accountNumber/id are BARE numerics. The pooled resolvers must
  // strip the literal prefix before matching, while still REPORTING the original recognized value.
  it('payment-number with a PREFIXED value strips the mask prefix before the bare-accountNumber match (#242)', async () => {
    const pool = [pay({ id: 'A', accountNumber: '6001/1' }), pay({ id: 'B', accountNumber: '6002/1' })]
    const r = await resolveIntentCandidates(intent('payment-number', 'ЗАК-6001/1'), ctx, call, fakeDeps({ pool }))
    expect(r.candidates.map(c => c.id)).toEqual(['A']) // «ЗАК-6001/1» → «6001/1» matches A
    expect(r.value).toBe('ЗАК-6001/1') // original recognized value is still reported
  })

  it('order-number with a PREFIXED value strips the prefix before the order-prefix match (#242)', async () => {
    const pool = [pay({ id: 'A', accountNumber: '6001/1' }), pay({ id: 'B', accountNumber: '6001/2' }), pay({ id: 'C', accountNumber: '7/1' })]
    const r = await resolveIntentCandidates(intent('order-number', 'ЗАК-6001'), ctx, call, fakeDeps({ pool }))
    expect(r.candidates.map(c => c.id)).toEqual(['A', 'B']) // «ЗАК-6001» → «6001» owns 6001/1 and 6001/2
    expect(r.value).toBe('ЗАК-6001')
  })

  it('payment-id with a PREFIXED value strips the prefix before the bare-id match (#242)', async () => {
    const pool = [pay({ id: '6001', accountNumber: '1/1' }), pay({ id: '6002', accountNumber: '1/2' })]
    const r = await resolveIntentCandidates(intent('payment-id', 'PAY-6001'), ctx, call, fakeDeps({ pool }))
    expect(r.candidates.map(c => c.id)).toEqual(['6001'])
  })

  it('order-id with a PREFIXED value strips the prefix before sale.payment.list lookup (#242)', async () => {
    const deps = fakeDeps({ pool: [pay({ id: '5', accountNumber: '1/1' })], orderPaymentIds: ['5'] })
    await resolveIntentCandidates(intent('order-id', 'ЗАК-1'), ctx, call, deps)
    expect(deps.findOrderPaymentIds).toHaveBeenCalledWith('1', call) // stripped orderId sent to sale lookup
  })

  it('payment-id → company pool then match by the payment OWN record id (#172)', async () => {
    const pool = [pay({ id: '5', accountNumber: '1/1' }), pay({ id: '7', accountNumber: '3/1' })]
    const deps = fakeDeps({ pool })
    const r = await resolveIntentCandidates(intent('payment-id', '5'), ctx, call, deps)
    expect(r.status).toBe('resolved')
    expect(r.candidates.map(c => c.id)).toEqual(['5']) // by record id, not accountNumber
    expect(deps.findCompanyDealPayments).toHaveBeenCalledWith('93', { isNegativeStage: ctx.isNegativeStage }, call)
  })

  it('payment-id not in the company pool → resolved [] (IDOR-safe: foreign payment absent)', async () => {
    const deps = fakeDeps({ pool: [pay({ id: '5', accountNumber: '1/1' })] })
    const r = await resolveIntentCandidates(intent('payment-id', '999'), ctx, call, deps)
    expect(r).toEqual({ kind: 'payment-id', value: '999', status: 'resolved', candidates: [] })
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
  const cases: IdentifierKind[] = ['document-number']
  for (const kind of cases) {
    it(`${kind} → unsupported, no resolver called, [] candidates, reason set`, async () => {
      const deps = fakeDeps({ invoices: [inv()], byId: inv(), byField: inv(), pool: [pay()] })
      const r = await resolveIntentCandidates(intent(kind, 'X'), ctx, call, deps)
      expect(r.status).toBe('unsupported')
      expect(r.candidates).toEqual([])
      expect(r.reason).toBeTruthy()
      expect(deps.findInvoicesByNumber).not.toHaveBeenCalled()
      expect(deps.findCandidateById).not.toHaveBeenCalled()
      expect(deps.findCandidateByField).not.toHaveBeenCalled()
      expect(deps.findCompanyDealPayments).not.toHaveBeenCalled()
    })
  }
})

describe('parseConfiguredEntityTypeId', () => {
  it('parses a positive integer string', () => {
    expect(parseConfiguredEntityTypeId('1032')).toBe(1032)
    expect(parseConfiguredEntityTypeId('  1030 ')).toBe(1030)
  })
  it('returns null for absent/blank/non-numeric/non-positive (fail-closed)', () => {
    expect(parseConfiguredEntityTypeId(undefined)).toBeNull()
    expect(parseConfiguredEntityTypeId('')).toBeNull()
    expect(parseConfiguredEntityTypeId('abc')).toBeNull()
    expect(parseConfiguredEntityTypeId('0')).toBeNull()
    expect(parseConfiguredEntityTypeId('-2')).toBeNull()
    expect(parseConfiguredEntityTypeId('3.5')).toBeNull()
  })
})

describe('resolveIntentCandidates — smart-process (config-driven entityTypeId, §4)', () => {
  const sp = (over: Partial<AllocationCandidate> = {}): AllocationCandidate =>
    ({ kind: 'smart-process', id: '9', amount: 0, currency: 'BYN', entityTypeId: 1032, ...over })

  it('smart-id with configured entityTypeId → findCandidateById(smart-process, <etid>, value)', async () => {
    const deps = fakeDeps({ byId: sp({ id: '9' }) })
    const ctxCfg = { ...ctx, configFields: { 'smart-entity': '1032' } }
    const r = await resolveIntentCandidates(intent('smart-id', '9'), ctxCfg, call, deps)
    expect(r.status).toBe('resolved')
    expect(r.candidates).toEqual([sp({ id: '9' })])
    expect(deps.findCandidateById).toHaveBeenCalledWith('smart-process', 1032, '9', { companyId: '93', isNegativeStage: ctx.isNegativeStage }, call)
  })

  it('smart-field with configured entityTypeId + field → findCandidateByField(smart-process, <etid>, <field>, value)', async () => {
    const deps = fakeDeps({ byField: sp({ id: '9' }) })
    const ctxCfg = { ...ctx, configFields: { 'smart-entity': '1032', 'smart-field': 'UF_CRM_5_PAY' } }
    const r = await resolveIntentCandidates(intent('smart-field', 'ЗАК-9'), ctxCfg, call, deps)
    expect(r.status).toBe('resolved')
    expect(r.candidates).toEqual([sp({ id: '9' })])
    expect(deps.findCandidateByField).toHaveBeenCalledWith('smart-process', 1032, 'UF_CRM_5_PAY', 'ЗАК-9', { companyId: '93', isNegativeStage: ctx.isNegativeStage }, call)
  })

  it('smart-id/smart-field with a configured field but no match → resolved with [] (not unsupported)', async () => {
    const deps = fakeDeps({ byId: null, byField: null })
    const ctxCfg = { ...ctx, configFields: { 'smart-entity': '1032', 'smart-field': 'UF_CRM_5_PAY' } }
    const rId = await resolveIntentCandidates(intent('smart-id', '9'), ctxCfg, call, deps)
    expect(rId).toMatchObject({ status: 'resolved', candidates: [] })
    const rField = await resolveIntentCandidates(intent('smart-field', 'ЗАК-9'), ctxCfg, call, deps)
    expect(rField).toMatchObject({ status: 'resolved', candidates: [] })
  })

  it('smart-id with NO configured entityTypeId → unsupported (reason set), resolver NOT called', async () => {
    const deps = fakeDeps({ byId: sp() })
    const r = await resolveIntentCandidates(intent('smart-id', '9'), ctx, call, deps) // no configFields
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBeTruthy()
    expect(deps.findCandidateById).not.toHaveBeenCalled()
  })

  it('smart-field with NO configured entityTypeId → unsupported (its own etid guard), resolver NOT called', async () => {
    const deps = fakeDeps({ byField: sp() })
    const ctxCfg = { ...ctx, configFields: { 'smart-field': 'UF_CRM_5_PAY' } } // field set, entityTypeId missing
    const r = await resolveIntentCandidates(intent('smart-field', 'ЗАК-9'), ctxCfg, call, deps)
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBeTruthy()
    expect(deps.findCandidateByField).not.toHaveBeenCalled()
  })

  it('smart-id with a NON-NUMERIC configured entityTypeId → unsupported (fail-closed)', async () => {
    const deps = fakeDeps({ byId: sp() })
    const ctxCfg = { ...ctx, configFields: { 'smart-entity': 'abc' } }
    const r = await resolveIntentCandidates(intent('smart-id', '9'), ctxCfg, call, deps)
    expect(r.status).toBe('unsupported')
    expect(deps.findCandidateById).not.toHaveBeenCalled()
  })

  it('smart-field WITH entityTypeId but NO field → unsupported, resolver NOT called', async () => {
    const deps = fakeDeps({ byField: sp() })
    const ctxCfg = { ...ctx, configFields: { 'smart-entity': '1032' } } // field missing
    const r = await resolveIntentCandidates(intent('smart-field', 'ЗАК-9'), ctxCfg, call, deps)
    expect(r.status).toBe('unsupported')
    expect(deps.findCandidateByField).not.toHaveBeenCalled()
  })
})

describe('resolveIntentCandidates — deal-field (by-config-field, §4)', () => {
  const deal = (over: Partial<AllocationCandidate> = {}): AllocationCandidate =>
    ({ kind: 'deal', id: '77', amount: 0, currency: 'BYN', ...over })

  it('with a configured field → findCandidateByField(deal, 2, field, value); found → single candidate', async () => {
    const deps = fakeDeps({ byField: deal({ id: '77' }) })
    const ctxCfg = { ...ctx, configFields: { 'deal-field': 'UF_CRM_PAY_NO' } }
    const r = await resolveIntentCandidates(intent('deal-field', 'ЗАК-6001'), ctxCfg, call, deps)
    expect(r.status).toBe('resolved')
    expect(r.candidates).toEqual([deal({ id: '77' })])
    expect(deps.findCandidateByField).toHaveBeenCalledWith('deal', 2, 'UF_CRM_PAY_NO', 'ЗАК-6001', { companyId: '93', isNegativeStage: ctx.isNegativeStage }, call)
  })

  it('with a configured field but no match → resolved with [] (not unsupported)', async () => {
    const deps = fakeDeps({ byField: null })
    const ctxCfg = { ...ctx, configFields: { 'deal-field': 'UF_CRM_PAY_NO' } }
    const r = await resolveIntentCandidates(intent('deal-field', 'ЗАК-6001'), ctxCfg, call, deps)
    expect(r.status).toBe('resolved')
    expect(r.candidates).toEqual([])
  })

  it('NO configured field → unsupported, resolver NOT called (can\'t look up)', async () => {
    const deps = fakeDeps({ byField: deal() })
    const r = await resolveIntentCandidates(intent('deal-field', 'ЗАК-6001'), ctx, call, deps) // ctx has no configFields
    expect(r.status).toBe('unsupported')
    expect(r.reason).toBeTruthy()
    expect(deps.findCandidateByField).not.toHaveBeenCalled()
  })
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

  it('order-id shares the single pool fetch (+ its own sale call), intersected with the pool', async () => {
    const deps = fakeDeps({ pool: [pay({ id: '5', accountNumber: '1/1' }), pay({ id: '7', accountNumber: '2/1' })], orderPaymentIds: ['7'] })
    const out = await resolveIntentsForOp(
      [intent('payment-id', '5'), intent('order-id', '2')], ctx, call, deps
    )
    expect(deps.findCompanyDealPayments).toHaveBeenCalledTimes(1) // one pool fetch for both
    expect(deps.findOrderPaymentIds).toHaveBeenCalledTimes(1) // order-id makes its own sale call
    expect(out.map(r => [r.kind, r.candidates.map(c => c.id)])).toEqual([
      ['payment-id', ['5']], ['order-id', ['7']]
    ])
  })

  it('fetches the pool for an order-id-only batch (it needs the pool for the intersection)', async () => {
    const deps = fakeDeps({ pool: [pay({ id: '5', accountNumber: '1/1' })], orderPaymentIds: ['5'] })
    await resolveIntentsForOp([intent('order-id', '1')], ctx, call, deps)
    expect(deps.findCompanyDealPayments).toHaveBeenCalledTimes(1)
  })

  it('payment-id, order-number and payment-number all share ONE pool fetch, each matched its own way', async () => {
    const deps = fakeDeps({ pool: [pay({ id: '5', accountNumber: '1/1' }), pay({ id: '7', accountNumber: '2/1' })] })
    const out = await resolveIntentsForOp(
      [intent('payment-id', '7'), intent('order-number', '1'), intent('payment-number', '2/1')], ctx, call, deps
    )
    expect(deps.findCompanyDealPayments).toHaveBeenCalledTimes(1) // one fetch feeds all three
    expect(out.map(r => [r.kind, r.candidates.map(c => c.id)])).toEqual([
      ['payment-id', ['7']], ['order-number', ['5']], ['payment-number', ['7']]
    ])
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
