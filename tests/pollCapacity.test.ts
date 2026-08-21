import { describe, expect, it } from 'vitest'
import {
  estimatePollCycle,
  estimateProviderCycles,
  formatPollCycle,
  planRequests,
  providerJobRate,
  providerRequestBudget,
  REQUESTS_PER_ACCOUNT,
  sweepRequests
} from '../server/queue/pollCapacity'
import { planFetches } from '../server/queue/cron'
import { fetchJobId } from '../server/queue/topology'

// Capacity arithmetic for marketplace scale: the banks cap requests per OAuth CLIENT (shared by
// every portal), so the sweep time — not CRON_INTERVAL_MIN — is the real statement freshness.

describe('sweepRequests', () => {
  it('costs 2 requests per Alfa account and ~10 per Prior account (async create+poll)', () => {
    // ⚠ Alfa became TWO in #561: the statement plus the page probe that proves there is no second
    // one. Not cosmetic — the limiter converts a REQUEST budget into JOBS through this number, so
    // understating it overspends the bank's cap while every dashboard still reads «within cap».
    expect(sweepRequests('alfa-by', 100)).toBe(200)
    expect(sweepRequests('prior-by', 100)).toBe(1000)
    expect(REQUESTS_PER_ACCOUNT['prior-by']).toBeGreaterThan(REQUESTS_PER_ACCOUNT['alfa-by']!)
  })
  it('defaults to 1 for an unknown provider and floors at 0', () => {
    expect(sweepRequests('whatever', 5)).toBe(5)
    expect(sweepRequests('alfa-by', -3)).toBe(0)
  })
})

describe('estimatePollCycle', () => {
  it('a marketplace-scale Alfa fleet needs ~210 min per sweep at 100 req/min', () => {
    // 10_500 accounts × 2 requests ÷ 100 per 60s = 12_600_000 ms = 210 min (#561 doubled the cost).
    const cycle = estimatePollCycle(sweepRequests('alfa-by', 10_500), 100, 60_000, 5 * 60_000)
    expect(cycle.requests).toBe(21_000)
    expect(cycle.cycleMs).toBe(210 * 60_000)
    // …which is FAR longer than a 5-minute tick — the cap, not the timer, sets the cadence.
    expect(cycle.exceedsInterval).toBe(true)
  })

  it('Prior costs 5× the same account count (per-REQUEST accounting, not per-job)', () => {
    // ⚠ Was 10×, now 5×: Prior did not get cheaper, Alfa got twice as expensive (#561). Asserted as
    // a RATIO over the constants themselves — a hardcoded multiplier would need editing on every
    // refinement of the model, and one day someone edits it «to make it green» without reading it.
    const ratio = (REQUESTS_PER_ACCOUNT['prior-by'] ?? 1) / (REQUESTS_PER_ACCOUNT['alfa-by'] ?? 1)
    const alfa = estimatePollCycle(sweepRequests('alfa-by', 20_600), 100, 60_000, 300_000)
    const prior = estimatePollCycle(sweepRequests('prior-by', 20_600), 100, 60_000, 300_000)
    expect(ratio).toBe(5)
    expect(prior.requests).toBe(alfa.requests * ratio)
    expect(prior.cycleMs).toBe(alfa.cycleMs * ratio)
  })

  it('a small fleet finishes inside one tick (no warning)', () => {
    const cycle = estimatePollCycle(sweepRequests('alfa-by', 50), 100, 60_000, 5 * 60_000)
    expect(cycle.cycleMs).toBe(60_000) // 50 × 2 requests ÷ 100/min (#561)
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
    // 10_500×2 + 20_600×10 = 227_000 bank requests for ONE sweep of the marketplace fleet (#561).
    expect(planRequests(plan)).toBe(227_000)
  })
})

describe('estimateProviderCycles (queues drain in PARALLEL, not serially)', () => {
  const plan = [
    { providerId: 'alfa-by', accounts: new Array(10_500).fill('a') },
    { providerId: 'prior-by', accounts: new Array(20_600).fill('p') }
  ]
  // Each provider has its OWN queue + limiter, so each is charged against its OWN budget.
  const rateFor = (p: string) => p === 'prior-by'
    ? { requests: 20, durationMs: 60_000 } // a DIFFERENT budget from Alfa's
    : { requests: 100, durationMs: 60_000 }

  it('charges each provider against its own budget (not one serial total)', () => {
    const [alfa, prior] = estimateProviderCycles(plan, rateFor, 5 * 60_000)
    expect(alfa!.provider).toBe('alfa-by')
    expect(alfa!.cycle.cycleMs).toBe(210 * 60_000) // 21_000 req ÷ 100/min (#561: 2 requests per account)
    expect(prior!.provider).toBe('prior-by')
    expect(prior!.cycle.cycleMs).toBe(10_300 * 60_000) // 206_000 req ÷ 20/min — its OWN, slower budget
  })

  it('a slow provider does not inflate the fast one (the serial-sum bug)', () => {
    const [alfa, prior] = estimateProviderCycles(plan, rateFor, 5 * 60_000)
    // A single summed number would report ~2165 min for BOTH; per-provider keeps Alfa honest.
    expect(alfa!.cycle.cycleMs).toBeLessThan(prior!.cycle.cycleMs)
    expect(alfa!.cycle.requests).toBe(21_000)
    expect(prior!.cycle.requests).toBe(206_000)
  })

  it('flags exceedsInterval per provider (a small Alfa fleet stays quiet while Prior warns)', () => {
    const mixed = [
      { providerId: 'alfa-by', accounts: new Array(50).fill('a') },
      { providerId: 'prior-by', accounts: new Array(500).fill('p') }
    ]
    const [alfa, prior] = estimateProviderCycles(mixed, rateFor, 5 * 60_000)
    expect(alfa!.cycle.exceedsInterval).toBe(false)
    expect(prior!.cycle.exceedsInterval).toBe(true)
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

describe('providerRequestBudget (the inverse of providerJobRate)', () => {
  it('converts a JOB-rate limiter back into the REQUEST budget it represents', () => {
    expect(providerRequestBudget('alfa-by', { max: 40, duration: 60_000 }))
      .toEqual({ requests: 80, durationMs: 60_000 })
    expect(providerRequestBudget('prior-by', { max: 20, duration: 60_000 }))
      .toEqual({ requests: 200, durationMs: 60_000 })
  })

  it('round-trips with providerJobRate for every pollable provider', () => {
    // ⚠ The point of having both functions: whatever the limiter is configured with, the sweep
    // estimate must be able to recover the request budget. Skipping the multiply is invisible —
    // the only symptom is a sweep estimate off by exactly `requestsPerAccount`, which then trips
    // `exceedsInterval` early and sends the operator to raise CRON_LOOKBACK_DAYS for nothing.
    for (const provider of ['alfa-by', 'prior-by']) {
      const cost = REQUESTS_PER_ACCOUNT[provider]!
      const jobs = providerJobRate(100, cost)
      expect(providerRequestBudget(provider, { max: jobs, duration: 60_000 }).requests).toBe(jobs * cost)
    }
  })

  it('an unknown provider costs one request per job (no silent multiplication)', () => {
    expect(providerRequestBudget('manual', { max: 7, duration: 1_000 }))
      .toEqual({ requests: 7, durationMs: 1_000 })
  })
})
