// Poll capacity arithmetic (pure) — what the poller can ACTUALLY sustain at marketplace scale.
//
// The banks rate-limit per OAuth CLIENT (our app), not per portal or per account: every connected
// account across every portal shares one budget. So the real question is not "how often does the
// cron tick" but "how long does one full sweep take" — and at tens of thousands of accounts those
// two numbers are wildly different (a 5-minute tick over a 105-minute sweep). Operators must see
// the sweep time, because that — not CRON_INTERVAL_MIN — is the statement freshness they get.
//
// Cost is per-REQUEST, not per-job: Alfa's sweep is one GET per account, but Prior's async
// create+poll spends up to ~10 HTTP calls per account, so the same job count is ~10× the bank
// traffic. `requestsPerAccount` makes that explicit instead of hiding it behind "jobs".
//
// No I/O — unit-tested, and the cron only logs from it (it never throttles here; the actual cap is
// the fleet-wide BullMQ limiter, A8).

/** Per-provider request cost of ONE account sweep. Alfa: a single statement GET. Prior: an
 *  accounts-resolve GET + a create POST + up to PRIOR_POLL_MAX_ATTEMPTS polls. */
export const REQUESTS_PER_ACCOUNT: Record<string, number> = {
  'alfa-by': 1,
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

/** Human-readable capacity line for the cron log (minutes, one decimal). Pure. */
export function formatPollCycle(accounts: number, cycle: PollCycle): string {
  const min = (cycle.cycleMs / 60_000).toFixed(1)
  return `${accounts} accounts ≈ ${cycle.requests} bank requests ≈ ${min} min per full sweep`
}
