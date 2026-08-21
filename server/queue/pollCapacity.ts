// Poll capacity arithmetic (pure) — what the poller can ACTUALLY sustain at marketplace scale.
//
// The banks rate-limit per OAuth CLIENT (our app), not per portal or per account: every connected
// account across every portal shares one budget. So the real question is not "how often does the
// cron tick" but "how long does one full sweep take" — and at tens of thousands of accounts those
// two numbers are wildly different (a 5-minute tick over a 105-minute sweep). Operators must see
// the sweep time, because that — not CRON_INTERVAL_MIN — is the statement freshness they get.
//
// Cost is per-REQUEST, not per-job, and NEITHER provider is one request per account any more: Alfa
// walks statement pages (#561, ~2 GETs on a day with operations) and Prior's async create+poll
// spends ~10 HTTP calls, so the same job count is 2×/10× the bank traffic.
// `requestsPerAccount` makes that explicit instead of hiding it behind "jobs".
//
// No I/O — unit-tested, and the cron only logs from it (it never throttles here; the actual cap is
// the fleet-wide BullMQ limiter, A8).

/**
 * Per-provider request cost of ONE account sweep — the TYPICAL cost, not a hard ceiling.
 *
 * ⚠ Alfa is **2**, not 1, since #561: the statement GET plus one page-walk request. The walk exists
 * because `pageRowCount: '0'` is documented as «все» but was never verified, and the portal showed
 * exactly 100 operations a day on five separate days — so a day with operations now always costs a
 * second request to prove there is no page two. A day with none still costs one, but the budget has
 * to assume the expensive case.
 *
 * ⚠ NEITHER number is a guaranteed maximum, and pretending otherwise would be the worse lie. A busy
 * Alfa account can walk further (up to MAX_ALFA_STATEMENT_PAGES) and a slow Prior resource can poll
 * further (up to PRIOR_POLL_MAX_ATTEMPTS = 20) — i.e. Prior's 10 has ALWAYS been a typical cost, and
 * Alfa's 2 is the same kind of number. What bounds the tail is not this constant: each walk/poll
 * carries its own page cap AND wall-clock budget, and both exits are logged loudly, so a fleet that
 * systematically costs more than budgeted says so in the log instead of quietly overspending.
 *
 * ⚠ Getting this wrong is SILENT and lands on the bank, not on us: the limiter counts JOBS, and if a
 * job secretly costs double, the fleet spends twice the budget while every dashboard says it is
 * within cap. That is the whole reason the number exists.
 *
 * Prior: an accounts-resolve GET + a create POST + up to PRIOR_POLL_MAX_ATTEMPTS polls.
 */
export const REQUESTS_PER_ACCOUNT: Record<string, number> = {
  'alfa-by': 2,
  'prior-by': 10
}

/** Requests one sweep of `accounts` accounts of `provider` costs (defaults to 1 when unknown). */
export function sweepRequests(provider: string, accounts: number): number {
  const per = REQUESTS_PER_ACCOUNT[provider] ?? 1
  return Math.max(0, Math.floor(accounts)) * per
}

export interface PollCycle {
  /** Total bank requests one full sweep costs. */
  requests: number
  /** Milliseconds one full sweep takes at the configured rate (0 when there is nothing to poll). */
  cycleMs: number
  /** True when a sweep cannot finish within one tick — i.e. the rate cap, not the timer, sets the
   *  real cadence. NOT an error: the stable-jobId backpressure makes this degrade gracefully. */
  exceedsInterval: boolean
}

/**
 * Estimate one full sweep: `requests / rate`. `rateMax` requests per `rateDurationMs` is the
 * fleet-wide limiter's budget (QUEUE_FETCH_RATE_*). A non-positive rate means "unthrottled" →
 * cycleMs 0. Pure.
 */
export function estimatePollCycle(
  requests: number,
  rateMax: number,
  rateDurationMs: number,
  intervalMs: number
): PollCycle {
  const req = Math.max(0, Math.floor(requests))
  if (req === 0 || rateMax <= 0 || rateDurationMs <= 0) {
    return { requests: req, cycleMs: 0, exceedsInterval: false }
  }
  const cycleMs = Math.ceil((req / rateMax) * rateDurationMs)
  return { requests: req, cycleMs, exceedsInterval: intervalMs > 0 && cycleMs > intervalMs }
}

/**
 * Per-provider sweep estimate — the shape the cron must report now that each provider drains from
 * its OWN queue and OWN limiter (they run in PARALLEL). Summing them into one serial number would
 * charge Prior's ~10× requests against Alfa's budget and understate whichever provider is slower,
 * which matters because that number is what tells the operator how to size CRON_LOOKBACK_DAYS.
 *
 * `rateFor(provider)` returns that provider's REQUEST budget per `durationMs`. Pure.
 */
export function estimateProviderCycles(
  plan: readonly { providerId: string, accounts: readonly unknown[] }[],
  rateFor: (provider: string) => { requests: number, durationMs: number },
  intervalMs: number
): { provider: string, accounts: number, cycle: PollCycle }[] {
  return plan.map((p) => {
    const rate = rateFor(p.providerId)
    return {
      provider: p.providerId,
      accounts: p.accounts.length,
      cycle: estimatePollCycle(sweepRequests(p.providerId, p.accounts.length), rate.requests, rate.durationMs, intervalMs)
    }
  })
}

/** Sum the per-provider sweep cost of a poll plan (the cron's grouped accounts). Pure. */
export function planRequests(plan: readonly { providerId: string, accounts: readonly unknown[] }[]): number {
  return plan.reduce((sum, p) => sum + sweepRequests(p.providerId, p.accounts.length), 0)
}

/**
 * Translate a bank's REQUEST budget into the JOB rate a BullMQ limiter can enforce.
 *
 * BullMQ's `limiter` counts JOBS, but banks count REQUESTS — and those differ by ~10× for Prior
 * (its async create+poll). Sizing a Prior queue's limiter with the raw request cap would therefore
 * let it spend ~10× the real budget. Divide instead: `jobs = requests / requestsPerAccount`.
 *
 * Floors at 1: a cost so high that the quotient rounds to 0 must still let ONE job through per
 * window (a stalled queue would be a silent outage, and the job's own poll budget bounds its cost).
 * Pure.
 */
export function providerJobRate(requestsPerWindow: number, requestsPerAccount: number): number {
  const requests = Math.floor(requestsPerWindow)
  const cost = Math.floor(requestsPerAccount)
  if (!Number.isFinite(requests) || requests < 1) return 1
  if (!Number.isFinite(cost) || cost < 1) return requests
  return Math.max(1, Math.floor(requests / cost))
}

/**
 * The inverse of {@link providerJobRate}: turn a provider's JOB-rate limiter back into the REQUEST
 * budget it actually represents.
 *
 * ⚠ This exists because forgetting it is invisible. `estimateProviderCycles` takes REQUESTS; a
 * limiter configured in JOBS looks like a plain number and substitutes silently, and the only symptom
 * is a sweep estimate off by exactly `requestsPerAccount` — which then trips `exceedsInterval` early
 * and tells the operator to raise CRON_LOOKBACK_DAYS for a fleet that is nowhere near the cap. That
 * had already happened for Alfa the moment its limiter started dividing (#561). Pure.
 */
export function providerRequestBudget(
  provider: string,
  jobs: { max: number, duration: number }
): { requests: number, durationMs: number } {
  return { requests: jobs.max * (REQUESTS_PER_ACCOUNT[provider] ?? 1), durationMs: jobs.duration }
}

/** Human-readable capacity line for the cron log (minutes, one decimal). Pure. */
export function formatPollCycle(accounts: number, cycle: PollCycle): string {
  const min = (cycle.cycleMs / 60_000).toFixed(1)
  return `${accounts} accounts ≈ ${cycle.requests} bank requests ≈ ${min} min per full sweep`
}
