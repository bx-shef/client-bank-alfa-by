import { describe, expect, it } from 'vitest'
import {
  estimatePollCycle,
  formatPollCycle,
  planRequests,
  providerJobRate,
  REQUESTS_PER_ACCOUNT,
  sweepRequests
} from '../server/queue/pollCapacity'
import { planFetches } from '../server/queue/cron'
import { fetchJobId } from '../server/queue/topology'

// Capacity arithmetic for marketplace scale: the banks cap requests per OAuth CLIENT (shared by
// every portal), so the sweep time — not CRON_INTERVAL_MIN — is the real statement freshness.

describe('sweepRequests', () => {
  it('costs 1 request per Alfa account and ~10 per Prior account (async create+poll)', () => {
    expect(sweepRequests('alfa-by', 100)).toBe(100)
    expect(sweepRequests('prior-by', 100)).toBe(1000)
    expect(REQUESTS_PER_ACCOUNT['prior-by']).toBeGreaterThan(REQUESTS_PER_ACCOUNT['alfa-by']!)
  })
  it('defaults to 1 for an unknown provider and floors at 0', () => {
    expect(sweepRequests('whatever', 5)).toBe(5)
    expect(sweepRequests('alfa-by', -3)).toBe(0)
  })
})

describe('estimatePollCycle', () => {
  it('a marketplace-scale Alfa fleet needs ~105 min per sweep at 100 req/min', () => {
    // 10_500 accounts × 1 request ÷ 100 per 60s = 6_300_000 ms = 105 min.
    const cycle = estimatePollCycle(sweepRequests('alfa-by', 10_500), 100, 60_000, 5 * 60_000)
    expect(cycle.requests).toBe(10_500)
    expect(cycle.cycleMs).toBe(105 * 60_000)
    // …which is FAR longer than a 5-minute tick — the cap, not the timer, sets the cadence.
    expect(cycle.exceedsInterval).toBe(true)
  })

  it('Prior costs ~10× the same account count (per-REQUEST accounting, not per-job)', () => {
    const alfa = estimatePollCycle(sweepRequests('alfa-by', 20_600), 100, 60_000, 300_000)
    const prior = estimatePollCycle(sweepRequests('prior-by', 20_600), 100, 60_000, 300_000)
    expect(prior.requests).toBe(alfa.requests * 10)
    expect(prior.cycleMs).toBe(alfa.cycleMs * 10)
  })

  it('a small fleet finishes inside one tick (no warning)', () => {
    const cycle = estimatePollCycle(sweepRequests('alfa-by', 50), 100, 60_000, 5 * 60_000)
    expect(cycle.cycleMs).toBe(30_000)
    expect(cycle.exceedsInterval).toBe(false)
  })

  it('nothing to poll / unthrottled → zero cycle, never a warning', () => {
    expect(estimatePollCycle(0, 100, 60_000, 1000)).toEqual({ requests: 0, cycleMs: 0, exceedsInterval: false })
    expect(estimatePollCycle(500, 0, 60_000, 1000).cycleMs).toBe(0)
    expect(estimatePollCycle(500, 100, 0, 1000).cycleMs).toBe(0)
  })
})

describe('providerJobRate (bank REQUESTS → BullMQ JOBS)', () => {
  it('divides the request budget by the per-job cost — Prior 100 req/min = 10 jobs/min', () => {
    expect(providerJobRate(100, REQUESTS_PER_ACCOUNT['prior-by']!)).toBe(10)
    // Sizing the limiter with the RAW request cap would spend ~10× the bank budget.
    expect(providerJobRate(100, 10)).toBeLessThan(100)
  })
  it('a 1-request provider (Alfa) passes the budget through unchanged', () => {
    expect(providerJobRate(100, 1)).toBe(100)
  })
  it('never returns 0 — a stalled queue would be a silent outage', () => {
    expect(providerJobRate(5, 100)).toBe(1)
    expect(providerJobRate(0, 10)).toBe(1)
    expect(providerJobRate(-5, 10)).toBe(1)
  })
  it('a non-positive cost falls back to the raw budget (no divide-by-zero)', () => {
    expect(providerJobRate(50, 0)).toBe(50)
  })
})

describe('planRequests', () => {
  it('sums the per-provider cost of a mixed plan', () => {
    const plan = [
      { providerId: 'alfa-by', accounts: new Array(10_500).fill('a') },
      { providerId: 'prior-by', accounts: new Array(20_600).fill('p') }
    ]
    // 10_500×1 + 20_600×10 = 216_500 bank requests for ONE sweep of the marketplace fleet.
    expect(planRequests(plan)).toBe(216_500)
  })
})

describe('formatPollCycle', () => {
  it('reads as an operator line', () => {
    const cycle = estimatePollCycle(10_500, 100, 60_000, 300_000)
    expect(formatPollCycle(10_500, cycle)).toBe('10500 accounts ≈ 10500 bank requests ≈ 105.0 min per full sweep')
  })
})

describe('cron enqueue is IDEMPOTENT (the backpressure that keeps Redis bounded)', () => {
  const plan = [{ memberId: 'M1', providerId: 'alfa-by' as const, accounts: ['A1', 'A2'] }]

  it('two ticks of the same window produce the SAME jobIds (a pending account is not re-added)', () => {
    // The cron omits `epoch` → identical plans ⇒ identical ids ⇒ BullMQ dedupes the second tick.
    const tick1 = planFetches(plan, '2026-07-27', '2026-07-28').map(fetchJobId)
    const tick2 = planFetches(plan, '2026-07-27', '2026-07-28').map(fetchJobId)
    expect(tick2).toEqual(tick1)
    expect(new Set(tick1).size).toBe(2) // still one distinct job per account
  })

  it('a per-tick epoch (manual «Опросить сейчас») DOES force distinct ids', () => {
    const a = planFetches(plan, '2026-07-27', '2026-07-28', 'epoch-1').map(fetchJobId)
    const b = planFetches(plan, '2026-07-27', '2026-07-28', 'epoch-2').map(fetchJobId)
    expect(b).not.toEqual(a)
  })

  it('a NEW window (next day) yields new ids — freshness is not dedup-blocked', () => {
    const today = planFetches(plan, '2026-07-27', '2026-07-28').map(fetchJobId)
    const tomorrow = planFetches(plan, '2026-07-28', '2026-07-29').map(fetchJobId)
    expect(tomorrow).not.toEqual(today)
  })
})
