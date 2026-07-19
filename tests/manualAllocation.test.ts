import { describe, expect, it } from 'vitest'
import type { DistributionEntry } from '~/utils/manualAllocation'
import { distributionSummary, reconcile, validateAllocation, validatePlan } from '~/utils/manualAllocation'

// Pure manual-distribution core (#109 §3): partial split of a payment across targets, «осталось
// распределить» = amount − Σ active same-currency distributions, over-limit + currency guards,
// and reconciliation when a target vanishes/un-applies. Modeled on the sync-payments visual.

const entry = (over: Partial<DistributionEntry> = {}): DistributionEntry =>
  ({ targetKind: 'deal-payment', targetId: '1', amount: 100, currency: 'BYN', source: 'manual', status: 'active', ...over })

describe('distributionSummary', () => {
  it('empty ledger → nothing distributed, full remaining', () => {
    expect(distributionSummary(1000, 'BYN', [])).toEqual({ total: 1000, distributed: 0, remaining: 1000, overLimit: false })
  })

  it('sums ACTIVE same-currency entries; remaining = total − distributed', () => {
    const s = distributionSummary(1000, 'BYN', [entry({ amount: 400 }), entry({ targetId: '2', amount: 350 })])
    expect(s).toEqual({ total: 1000, distributed: 750, remaining: 250, overLimit: false })
  })

  it('ignores reverted entries and different-currency entries', () => {
    const s = distributionSummary(1000, 'BYN', [
      entry({ amount: 400 }),
      entry({ targetId: '2', amount: 300, status: 'reverted' }), // reverted → freed
      entry({ targetId: '3', amount: 999, currency: 'USD' }) // other currency → not added
    ])
    expect(s.distributed).toBe(400)
    expect(s.remaining).toBe(600)
  })

  it('over-allocation flags overLimit and clamps remaining to 0', () => {
    const s = distributionSummary(1000, 'BYN', [entry({ amount: 600 }), entry({ targetId: '2', amount: 600 })])
    expect(s.overLimit).toBe(true)
    expect(s.remaining).toBe(0)
  })

  it('non-finite total coerces to 0 (bad row can\'t poison the summary)', () => {
    expect(distributionSummary(Number.NaN, 'BYN', []).total).toBe(0)
  })

  it('negative total clamps to 0 and does NOT spuriously flag overLimit on an empty ledger', () => {
    expect(distributionSummary(-100, 'BYN', [])).toEqual({ total: 0, distributed: 0, remaining: 0, overLimit: false })
  })

  it('rounds without float drift (0.1+0.2 style)', () => {
    const s = distributionSummary(0.3, 'BYN', [entry({ amount: 0.1 }), entry({ targetId: '2', amount: 0.2 })])
    expect(s.distributed).toBe(0.3)
    expect(s.remaining).toBe(0)
    expect(s.overLimit).toBe(false)
  })
})

describe('validateAllocation (single proposed allocation)', () => {
  it('accepts an in-bounds same-currency amount', () => {
    expect(validateAllocation(500, 'BYN', { amount: 300, currency: 'BYN' })).toBeNull()
  })
  it('rejects a currency mismatch', () => {
    expect(validateAllocation(500, 'BYN', { amount: 300, currency: 'USD' })).toBe('currency-mismatch')
  })
  it('rejects a non-positive amount', () => {
    expect(validateAllocation(500, 'BYN', { amount: 0, currency: 'BYN' })).toBe('non-positive')
    expect(validateAllocation(500, 'BYN', { amount: -5, currency: 'BYN' })).toBe('non-positive')
  })
  it('rejects an amount over the target cap (deal-payment sum)', () => {
    expect(validateAllocation(500, 'BYN', { amount: 300, currency: 'BYN', max: 250 })).toBe('exceeds-target')
  })
  it('rejects an amount over the remaining', () => {
    expect(validateAllocation(200, 'BYN', { amount: 300, currency: 'BYN' })).toBe('exceeds-remaining')
  })
  it('allows distributing the EXACT remainder (epsilon tolerance, no float rejection)', () => {
    expect(validateAllocation(0.3, 'BYN', { amount: 0.1 + 0.2, currency: 'BYN' })).toBeNull()
  })
})

describe('validatePlan (whole pending plan — the «Распределить» gate)', () => {
  it('ok when sum > 0, within remaining, no line faults', () => {
    const p = validatePlan(1000, 'BYN', [{ amount: 400, currency: 'BYN' }, { amount: 300, currency: 'BYN' }])
    expect(p).toMatchObject({ wantDistribute: 700, overLimit: false, ok: true })
    expect(p.lineRejects).toEqual([null, null])
  })
  it('over-limit when the plan total exceeds remaining → not ok', () => {
    const p = validatePlan(500, 'BYN', [{ amount: 400, currency: 'BYN' }, { amount: 300, currency: 'BYN' }])
    expect(p.overLimit).toBe(true)
    expect(p.ok).toBe(false)
  })
  it('a line fault (currency / over its own cap) blocks ok even under the remaining', () => {
    const p = validatePlan(1000, 'BYN', [{ amount: 100, currency: 'USD' }, { amount: 100, currency: 'BYN', max: 50 }])
    expect(p.lineRejects).toEqual(['currency-mismatch', 'exceeds-target'])
    expect(p.ok).toBe(false)
  })
  it('empty / all-zero plan → wantDistribute 0, not ok (nothing to distribute)', () => {
    expect(validatePlan(1000, 'BYN', []).ok).toBe(false)
    expect(validatePlan(1000, 'BYN', [{ amount: 0, currency: 'BYN' }]).ok).toBe(false)
  })
})

describe('reconcile (§3 — target vanished / un-applied)', () => {
  const live = new Set(['deal-payment|1', 'invoice|9'])
  const probe = (kind: string, id: string) => live.has(`${kind}|${id}`)

  it('keeps entries whose target is still live', () => {
    const r = reconcile([entry({ targetKind: 'deal-payment', targetId: '1' })], probe)
    expect(r.dropped).toHaveLength(0)
    expect(r.kept).toHaveLength(1)
    expect(r.needsRedistribution).toBe(false)
  })

  it('drops (→ reverted) an entry whose target vanished; a MANUAL drop needs redistribution', () => {
    const r = reconcile([entry({ targetKind: 'deal-payment', targetId: '404', source: 'manual' })], probe)
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0]!.status).toBe('reverted')
    expect(r.needsRedistribution).toBe(true)
  })

  it('an AUTO drop is silent — later changes to an auto allocation are ignored (§3)', () => {
    const r = reconcile([entry({ targetKind: 'deal-payment', targetId: '404', source: 'auto' })], probe)
    expect(r.dropped).toHaveLength(1)
    expect(r.needsRedistribution).toBe(false)
  })

  it('already-reverted entries are kept as history, not re-probed', () => {
    const r = reconcile([entry({ targetId: '404', status: 'reverted', source: 'manual' })], probe)
    expect(r.kept).toHaveLength(1)
    expect(r.dropped).toHaveLength(0)
    expect(r.needsRedistribution).toBe(false)
  })

  it('mixed: keeps live, drops dead, flags redistribution for the manual dead one', () => {
    const r = reconcile([
      entry({ targetKind: 'deal-payment', targetId: '1', source: 'manual' }), // live
      entry({ targetKind: 'invoice', targetId: '9', source: 'auto' }), // live
      entry({ targetKind: 'invoice', targetId: '77', source: 'manual' }) // dead
    ], probe)
    expect(r.kept.map(e => e.targetId).sort()).toEqual(['1', '9'])
    expect(r.dropped.map(e => e.targetId)).toEqual(['77'])
    expect(r.needsRedistribution).toBe(true)
  })
})
