import { describe, expect, it } from 'vitest'
import type { AllocationCandidate } from '~/utils/allocation'
import { resolveAllocation } from '~/utils/allocation'
import type { MatchMatrix } from '~/utils/purposeMatch'
import { recognizeByMatrices } from '~/utils/purposeMatch'
import { routeIdentifier } from '~/utils/identifierDispatch'

// Composition test for the #109 pipeline: recognizeByMatrices → routeIdentifier →
// resolveAllocation, exercised end-to-end on a small mock. The fuzz harness
// (scripts/fuzz-allocation.ts) explores this path with random data; THIS is the
// machine-checked CI gate that catches cross-module drift (a kind that stops
// routing, a decision contract change, a recognizer that stops matching a mask).

const MATRICES: MatchMatrix[] = [
  { mask: 'СЧ-dddd', kind: 'invoice-number' },
  { mask: 'ЗАК-dddd', kind: 'order-number' },
  { mask: 'СД-dd', kind: 'deal-id' }
]

/** Recognize the single identifier in a purpose (helper for the search-path tests). */
function recognizeOne(purpose: string) {
  const ids = recognizeByMatrices(purpose, MATRICES)
  expect(ids).toHaveLength(1)
  return ids[0]!
}

describe('allocation pipeline (recognize → route → resolve)', () => {
  it('exact invoice number → invoice target → allocate (not ambiguous)', () => {
    const id = recognizeOne('оплата по СЧ-2001')
    expect(id).toEqual({ kind: 'invoice-number', value: 'СЧ-2001' })
    expect(routeIdentifier(id.kind)).toMatchObject({ targetKind: 'invoice', strategy: 'by-number' })

    const candidates: AllocationCandidate[] = [{ kind: 'invoice', id: 'INV-1', amount: 100, currency: 'BYN' }]
    expect(resolveAllocation({ amount: 100, currency: 'BYN', candidates }))
      .toEqual({ action: 'allocate', target: candidates[0], ambiguous: false, alternatives: [] })
  })

  it('two same-amount invoices → allocate smallest id, ambiguous (chat heads-up)', () => {
    const candidates: AllocationCandidate[] = [
      { kind: 'invoice', id: 'INV-9', amount: 250, currency: 'BYN' },
      { kind: 'invoice', id: 'INV-8', amount: 250, currency: 'BYN' }
    ]
    const d = resolveAllocation({ amount: 250, currency: 'BYN', candidates })
    expect(d).toMatchObject({ action: 'allocate', ambiguous: true })
    if (d.action === 'allocate') expect(d.target.id).toBe('INV-8')
  })

  it('partial payment (amount differs) → manual', () => {
    recognizeOne('оплата СЧ-2001') // recognized fine; the amount is what fails
    const candidates: AllocationCandidate[] = [{ kind: 'invoice', id: 'INV-1', amount: 100, currency: 'BYN' }]
    expect(resolveAllocation({ amount: 60, currency: 'BYN', candidates }))
      .toMatchObject({ action: 'manual', reason: 'no-exact-match' })
  })

  it('order number → deal-payment target by-order-number (payment accountNumber prefix, #172)', () => {
    const id = recognizeOne('оплата заказа ЗАК-6001')
    expect(id).toEqual({ kind: 'order-number', value: 'ЗАК-6001' })
    expect(routeIdentifier(id.kind)).toMatchObject({ targetKind: 'deal-payment', strategy: 'by-order-number' })
  })

  it('deal id → deal target, by-id (unconditional trigger — bypasses amount core)', () => {
    const id = recognizeOne('оплата СД-22')
    expect(id).toEqual({ kind: 'deal-id', value: 'СД-22' })
    // deal/smart are direct trigger targets: routed as by-id, not sent to resolveAllocation.
    expect(routeIdentifier(id.kind)).toMatchObject({ targetKind: 'deal', strategy: 'by-id', needsConfiguredField: false })
  })

  it('unrecognized purpose (space instead of dash) → no identifier', () => {
    expect(recognizeByMatrices('оплата СЧ 2001', MATRICES)).toEqual([])
  })

  it('no candidates at all → none (record a plain дело)', () => {
    expect(resolveAllocation({ amount: 100, currency: 'BYN', candidates: [] }))
      .toEqual({ action: 'none', reason: 'no-candidates' })
  })
})
