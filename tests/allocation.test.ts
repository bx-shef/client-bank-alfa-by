import { describe, expect, it } from 'vitest'
import type { AllocationCandidate, AllocationInput } from '~/utils/allocation'
import {
  ALLOCATION_TARGET_ROLE,
  allocationFactKey,
  buildAllocationNote,
  collapseSameTarget,
  compareIds,
  filterByAccountNumber,
  isAmountTarget,
  isEligible,
  isTriggerTarget,
  resolveAllocation,
  sameCurrency,
  summarizeAllocation,
  toMinorUnits
} from '~/utils/allocation'

// Pure allocation core (#109). Eligible = amount AND currency match exactly.
// Allocate to the smallest-id exact match; when several distinct targets match,
// still allocate (min id) but flag `ambiguous` for a chat heads-up. `manual` only
// for partial/group (amount ≠) or currency mismatch; `none` when no candidates.
// Covers happy path, mixed eligible/ineligible, partial, currency mismatch,
// invoice↔deal-payment same-deal collapse (invoice preferred), cross-kind id
// collision (stay distinct → ambiguous), several distinct → min-id+ambiguous,
// and the idempotent fact key.

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
  it('matches an exact zero/negative amount (сторно/возврат) — direction is out of scope', () => {
    expect(isEligible(payment({ amount: 0 }), inv({ amount: 0 }))).toBe(true)
    expect(isEligible(payment({ amount: -100 }), inv({ amount: -100 }))).toBe(true)
    expect(isEligible(payment({ amount: -100 }), inv({ amount: 100 }))).toBe(false)
  })
})

describe('resolveAllocation', () => {
  it('no candidates → none', () => {
    expect(resolveAllocation(payment())).toEqual({ action: 'none', reason: 'no-candidates' })
  })

  it('exactly one exact match → allocate it, not ambiguous', () => {
    const target = inv({ id: '42' })
    expect(resolveAllocation(payment({ candidates: [target] })))
      .toEqual({ action: 'allocate', target, ambiguous: false, alternatives: [] })
  })

  it('picks the single eligible one out of a mixed set (ineligible ones ignored)', () => {
    const target = inv({ id: '1', amount: 100 })
    const wrongAmount = inv({ id: '2', amount: 999 })
    const wrongCurrency = inv({ id: '3', currency: 'RUB' })
    const d = resolveAllocation(payment({ candidates: [target, wrongAmount, wrongCurrency] }))
    expect(d).toEqual({ action: 'allocate', target, ambiguous: false, alternatives: [] })
  })

  it('partial payment (amount differs) → manual no-exact-match, keeps all candidates', () => {
    const c = inv({ amount: 150 })
    expect(resolveAllocation(payment({ amount: 100, candidates: [c] })))
      .toEqual({ action: 'manual', reason: 'no-exact-match', candidates: [c] })
  })

  it('currency mismatch only → manual no-exact-match, keeps all candidates', () => {
    const c = inv({ currency: 'RUB' })
    expect(resolveAllocation(payment({ candidates: [c] })))
      .toEqual({ action: 'manual', reason: 'no-exact-match', candidates: [c] })
  })

  it('invoice + a deal-payment of the SAME deal → allocate the invoice, not ambiguous', () => {
    const invoice = inv({ id: '7', dealId: '55' })
    const dealPayment = pay({ id: 'P9', dealId: '55' }) // own record id P9, same deal 55
    const d = resolveAllocation(payment({ candidates: [invoice, dealPayment] }))
    expect(d).toEqual({ action: 'allocate', target: invoice, ambiguous: false, alternatives: [] })
  })

  it('two different invoices of the same amount → allocate min id, ambiguous (chat heads-up)', () => {
    const nine = inv({ id: '9' })
    const ten = inv({ id: '10' })
    const d = resolveAllocation(payment({ candidates: [ten, nine] }))
    expect(d).toEqual({ action: 'allocate', target: nine, ambiguous: true, alternatives: [ten] })
  })

  it('invoice + unrelated deal-payment sharing a numeric id → distinct, allocate min id, ambiguous', () => {
    const invoice = inv({ id: '7', dealId: '55' })
    const unrelated = pay({ id: '7', dealId: '88' }) // same numeric id, different deal
    const d = resolveAllocation(payment({ candidates: [invoice, unrelated] }))
    expect(d).toMatchObject({ action: 'allocate', ambiguous: true })
    if (d.action === 'allocate') {
      expect([d.target, ...d.alternatives]).toHaveLength(2) // both kept, none merged
    }
  })

  it('invoice + unrelated deal-payment (distinct deals) → allocate min id, ambiguous', () => {
    const invoice = inv({ id: '7', dealId: '55' })
    const other = pay({ id: '99', dealId: '88' }) // unrelated deal, not covered by the invoice
    const d = resolveAllocation(payment({ candidates: [invoice, other] }))
    expect(d).toEqual({ action: 'allocate', target: invoice, ambiguous: true, alternatives: [other] })
  })

  it('literal duplicate of one entity (same kind+id) collapses → single, not ambiguous', () => {
    const d = resolveAllocation(payment({ candidates: [inv({ id: '5' }), inv({ id: '5' })] }))
    expect(d).toEqual({ action: 'allocate', target: inv({ id: '5' }), ambiguous: false, alternatives: [] })
  })
})

describe('collapseSameTarget', () => {
  it('drops a deal-payment whose deal an invoice covers, keeps distinct ones', () => {
    const invoice = inv({ id: '7', dealId: '55' })
    const covered = pay({ id: 'P1', dealId: '55' })
    const distinctPay = pay({ id: 'P2', dealId: '80' })
    const kept = collapseSameTarget([invoice, covered, distinctPay])
    expect(kept.map(c => c.id).sort()).toEqual(['7', 'P2'])
  })
})

describe('filterByAccountNumber', () => {
  const pool = [
    pay({ id: 'P1', accountNumber: '1/1' }),
    pay({ id: 'P2', accountNumber: '1/2' }),
    pay({ id: 'P3' }) // no accountNumber (e.g. an invoice candidate)
  ]
  it('keeps only candidates whose accountNumber matches exactly (payment-number)', () => {
    expect(filterByAccountNumber(pool, '1/2').map(c => c.id)).toEqual(['P2'])
  })
  it('trims the requested number', () => {
    expect(filterByAccountNumber(pool, '  1/1  ').map(c => c.id)).toEqual(['P1'])
  })
  it('returns [] for a blank number (never sweeps the whole pool)', () => {
    expect(filterByAccountNumber(pool, '')).toEqual([])
    expect(filterByAccountNumber(pool, '   ')).toEqual([])
  })
  it('does not match an order-number against an order-prefixed payment number', () => {
    // «1» is an order number; payments are «1/1»/«1/2» — NOT an exact match here (#172).
    expect(filterByAccountNumber(pool, '1')).toEqual([])
  })
  it('returns ALL candidates sharing the number (filter, not find)', () => {
    const dup = [pay({ id: 'A', accountNumber: '1/2' }), pay({ id: 'B', accountNumber: '1/2' }), pay({ id: 'C', accountNumber: '1/3' })]
    expect(filterByAccountNumber(dup, '1/2').map(c => c.id)).toEqual(['A', 'B'])
  })
  it('ignores candidates that carry no accountNumber', () => {
    expect(filterByAccountNumber([pay({ id: 'P3' })], 'x')).toEqual([])
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
  it('differs by payment (same target, different account/docId)', () => {
    const target = { kind: 'invoice', id: '7' } as const
    expect(allocationFactKey({ account: 'A', docId: '1' }, target))
      .not.toBe(allocationFactKey({ account: 'A', docId: '2' }, target))
    expect(allocationFactKey({ account: 'A', docId: '1' }, target))
      .not.toBe(allocationFactKey({ account: 'B', docId: '1' }, target))
  })
})

describe('target-kind role (single source of truth)', () => {
  it('classifies every AllocationTargetKind as amount or trigger', () => {
    expect(ALLOCATION_TARGET_ROLE).toEqual({
      'invoice': 'amount', 'deal-payment': 'amount', 'deal': 'trigger', 'smart-process': 'trigger'
    })
  })
  it('isAmountTarget / isTriggerTarget agree with the role', () => {
    expect(isAmountTarget('invoice')).toBe(true)
    expect(isAmountTarget('deal-payment')).toBe(true)
    expect(isAmountTarget('deal')).toBe(false)
    expect(isTriggerTarget('deal')).toBe(true)
    expect(isTriggerTarget('smart-process')).toBe(true)
    expect(isTriggerTarget('invoice')).toBe(false)
  })
})

describe('summarizeAllocation', () => {
  const inv = (id: string, amount: number, currency = 'BYN'): AllocationCandidate => ({ kind: 'invoice', id, amount, currency })
  const pay = (amount: number, currency = 'BYN', candidates: AllocationCandidate[] = []): AllocationInput => ({ amount, currency, candidates })

  it('exact amount match → allocatable (decision allocate, 0 triggers)', () => {
    const s = summarizeAllocation(pay(10, 'BYN', [inv('7', 10)]))
    expect(s.outcome).toBe('allocatable')
    expect(s.triggerTargets).toBe(0)
    expect(s.decision).toMatchObject({ action: 'allocate', target: { id: '7' }, ambiguous: false })
  })

  it('two distinct exact matches → ambiguous (smallest id)', () => {
    const s = summarizeAllocation(pay(10, 'BYN', [inv('9', 10), inv('5', 10)]))
    expect(s.outcome).toBe('ambiguous')
    expect(s.decision).toMatchObject({ action: 'allocate', target: { id: '5' }, ambiguous: true })
  })

  it('amount candidates but no exact match → manual', () => {
    expect(summarizeAllocation(pay(10, 'BYN', [inv('7', 100)])).outcome).toBe('manual')
    expect(summarizeAllocation(pay(10, 'BYN', [inv('7', 10, 'USD')])).outcome).toBe('manual') // currency mismatch
  })

  it('trigger target only → allocatable (bypasses amount), decision none', () => {
    const s = summarizeAllocation(pay(10, 'BYN', [{ kind: 'deal', id: '3', amount: 0, currency: '' }]))
    expect(s.outcome).toBe('allocatable')
    expect(s.triggerTargets).toBe(1)
    expect(s.decision.action).toBe('none')
  })

  it('non-matching amount + a trigger → allocatable (trigger overrides manual)', () => {
    const s = summarizeAllocation(pay(10, 'BYN', [inv('7', 100), { kind: 'deal', id: '3', amount: 0, currency: '' }]))
    expect(s.outcome).toBe('allocatable')
    expect(s.triggerTargets).toBe(1)
    expect(s.decision.action).toBe('manual') // the amount decision itself is manual
  })

  it('no candidates → none', () => {
    expect(summarizeAllocation(pay(10, 'BYN', [])).outcome).toBe('none')
  })

  it('invoice + deal-payment of the same deal collapse → allocatable, not ambiguous', () => {
    const s = summarizeAllocation(pay(10, 'BYN', [
      { kind: 'invoice', id: '7', amount: 10, currency: 'BYN', dealId: '2' },
      { kind: 'deal-payment', id: '4', amount: 10, currency: 'BYN', dealId: '2' }
    ]))
    expect(s.outcome).toBe('allocatable')
    expect(s.decision).toMatchObject({ action: 'allocate', target: { kind: 'invoice', id: '7' } })
  })
})

describe('buildAllocationNote (CRM activity preview)', () => {
  const sum = (amount: number, currency: string, candidates: AllocationCandidate[]) =>
    summarizeAllocation({ amount, currency, candidates })

  it('exact invoice match → names the target', () => {
    const note = buildAllocationNote(sum(10, 'BYN', [{ kind: 'invoice', id: '7', amount: 10, currency: 'BYN' }]))
    expect(note).toBe('Предпросмотр разнесения: инвойс #7 — точное совпадение суммы')
  })
  it('ambiguous → names the chosen target + count', () => {
    const note = buildAllocationNote(sum(10, 'BYN', [
      { kind: 'invoice', id: '9', amount: 10, currency: 'BYN' }, { kind: 'invoice', id: '5', amount: 10, currency: 'BYN' }
    ]))
    expect(note).toBe('Предпросмотр разнесения: несколько совпадений, выбран инвойс #5 (+1) — требуется проверка')
  })
  it('manual (no exact match) → ручной разбор', () => {
    expect(buildAllocationNote(sum(10, 'BYN', [{ kind: 'invoice', id: '7', amount: 100, currency: 'BYN' }])))
      .toBe('Предпросмотр разнесения: точного совпадения суммы нет — ручной разбор')
  })
  it('trigger target → срабатывание по цели', () => {
    const note = buildAllocationNote(sum(10, 'BYN', [{ kind: 'deal', id: '3', amount: 0, currency: '' }]))
    expect(note).toBe('Предпросмотр разнесения: срабатывание по цели (сделка/смарт-процесс) — 1 шт.')
  })
  it('deal-payment target uses its RU label', () => {
    const note = buildAllocationNote(sum(10, 'BYN', [{ kind: 'deal-payment', id: '4', amount: 10, currency: 'BYN' }]))
    expect(note).toBe('Предпросмотр разнесения: оплата сделки #4 — точное совпадение суммы')
  })
  it('none (no candidates) → empty note', () => {
    expect(buildAllocationNote(sum(10, 'BYN', []))).toBe('')
  })
})
