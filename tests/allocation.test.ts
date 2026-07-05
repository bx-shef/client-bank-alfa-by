import { describe, expect, it } from 'vitest'
import type { AllocationCandidate, AllocationInput } from '~/utils/allocation'
import {
  allocationFactKey,
  collapseSameTarget,
  compareIds,
  isEligible,
  resolveAllocation,
  sameCurrency,
  toMinorUnits
} from '~/utils/allocation'

// Pure allocation core (#109). Criterion: auto-allocate only when exactly one
// distinct target matches BOTH amount and currency; everything else → manual /
// none. Covers happy path, partial/group (amount mismatch), currency mismatch,
// invoice↔deal-payment same-target collapse, identical-dupe min-id tie-break,
// several distinct → manual, and the idempotent fact key.

function inv(over: Partial<AllocationCandidate> = {}): AllocationCandidate {
  return { kind: 'invoice', id: '1', amount: 100, currency: 'BYN', ...over }
}
function pay(over: Partial<AllocationCandidate> = {}): AllocationCandidate {
  return { kind: 'deal-payment', id: '1', amount: 100, currency: 'BYN', ...over }
}
function payment(over: Partial<AllocationInput> = {}): AllocationInput {
  return { amount: 100, currency: 'BYN', candidates: [], ...over }
}

describe('toMinorUnits', () => {
  it('rounds to cents so float noise never breaks equality', () => {
    expect(toMinorUnits(0.1 + 0.2)).toBe(30) // 0.30000000000000004 → 30
    expect(toMinorUnits(100)).toBe(10000)
    expect(toMinorUnits(100.005)).toBe(10001)
  })
})

describe('sameCurrency', () => {
  it('is case-insensitive and trimmed', () => {
    expect(sameCurrency('byn', ' BYN ')).toBe(true)
    expect(sameCurrency('BYN', 'RUB')).toBe(false)
  })
})

describe('compareIds', () => {
  it('orders numeric ids numerically (9 before 10)', () => {
    expect(compareIds('9', '10')).toBeLessThan(0)
    expect(compareIds('10', '9')).toBeGreaterThan(0)
  })
  it('falls back to lexicographic for non-numeric ids', () => {
    expect(compareIds('a', 'b')).toBeLessThan(0)
    expect(compareIds('x', 'x')).toBe(0)
  })
})

describe('isEligible', () => {
  it('requires both amount and currency to match', () => {
    const p = payment()
    expect(isEligible(p, inv())).toBe(true)
    expect(isEligible(p, inv({ amount: 99 }))).toBe(false) // partial
    expect(isEligible(p, inv({ currency: 'RUB' }))).toBe(false) // currency
  })
})

describe('resolveAllocation', () => {
  it('no candidates → none', () => {
    expect(resolveAllocation(payment())).toEqual({ action: 'none', reason: 'no-candidates' })
  })

  it('exactly one exact match → allocate it', () => {
    const target = inv({ id: '42' })
    expect(resolveAllocation(payment({ candidates: [target] }))).toEqual({ action: 'allocate', target })
  })

  it('partial payment (amount differs) → manual no-exact-match', () => {
    const d = resolveAllocation(payment({ amount: 100, candidates: [inv({ amount: 150 })] }))
    expect(d).toMatchObject({ action: 'manual', reason: 'no-exact-match' })
  })

  it('currency mismatch only → manual no-exact-match', () => {
    const d = resolveAllocation(payment({ candidates: [inv({ currency: 'RUB' })] }))
    expect(d).toMatchObject({ action: 'manual', reason: 'no-exact-match' })
  })

  it('invoice + its own deal-payment (same deal) → allocate the invoice', () => {
    const invoice = inv({ id: '7', dealId: '55' })
    const dealPayment = pay({ id: '55' }) // deal-payment id == invoice.dealId
    const d = resolveAllocation(payment({ candidates: [invoice, dealPayment] }))
    expect(d).toEqual({ action: 'allocate', target: invoice })
  })

  it('identical duplicate invoices (same amount/currency) → allocate min id', () => {
    const d = resolveAllocation(payment({ candidates: [inv({ id: '10' }), inv({ id: '9' })] }))
    expect(d).toEqual({ action: 'allocate', target: inv({ id: '9' }) })
  })

  it('two distinct targets (invoice + unrelated deal-payment) → manual multiple-candidates', () => {
    const invoice = inv({ id: '7', dealId: '55' })
    const other = pay({ id: '99' }) // unrelated deal, not covered by the invoice
    const d = resolveAllocation(payment({ candidates: [invoice, other] }))
    expect(d).toMatchObject({ action: 'manual', reason: 'multiple-candidates' })
    if (d.action === 'manual') expect(d.candidates).toHaveLength(2)
  })
})

describe('collapseSameTarget', () => {
  it('drops a deal-payment covered by an invoice, keeps distinct ones', () => {
    const invoice = inv({ id: '7', dealId: '55' })
    const covered = pay({ id: '55' })
    const distinctPay = pay({ id: '80' })
    const kept = collapseSameTarget([invoice, covered, distinctPay])
    expect(kept.map(c => c.id).sort()).toEqual(['7', '80'])
  })
})

describe('allocationFactKey', () => {
  const key = 'ACC1|DOC1'
  it('is stable for the same (payment, target) — idempotent redelivery', () => {
    const a = allocationFactKey({ account: 'ACC1', docId: 'DOC1' }, { kind: 'invoice', id: '7' })
    const b = allocationFactKey({ account: 'ACC1', docId: 'DOC1' }, { kind: 'invoice', id: '7' })
    expect(a).toBe(b)
    expect(a).toBe(`${key}|invoice|7`)
  })
  it('differs by target kind and id', () => {
    const base = { account: 'ACC1', docId: 'DOC1' }
    expect(allocationFactKey(base, { kind: 'invoice', id: '7' }))
      .not.toBe(allocationFactKey(base, { kind: 'deal-payment', id: '7' }))
    expect(allocationFactKey(base, { kind: 'invoice', id: '7' }))
      .not.toBe(allocationFactKey(base, { kind: 'invoice', id: '8' }))
  })
})
