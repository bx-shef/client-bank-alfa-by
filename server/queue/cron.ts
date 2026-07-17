// Cron planning + a self-contained load demo — pure functions (no Redis/timers),
// so they're unit-testable. The plugin (server/plugins/queue.ts) wires them to a
// real interval and the producers.
//
// Real polling (stage 5, A10 WIRED): accountsForPolling() + planFetches() turn the
// connected bank accounts (A6 registry over the bank_tokens store) into one fetch job per
// account for a rolling window; the plugin runs it every CRON_INTERVAL_MIN. It is INERT
// until accounts are connected (A7) — an empty registry enqueues nothing. Meanwhile the
// DEMO path below exercises the pipeline: each tick enqueues N synthetic fetch jobs whose
// handler emits demo operations, so you can watch load flow bank-fetch → crm-sync via
// GET /api/queues.

import type { BankProviderId, StatementItem } from '../../app/types/statement'
import type { FetchJob } from './topology'
import type { BankAccountRef } from '../utils/bankTokenStore'

/** Interval in ms from a minutes setting (clamped to a sane floor of 1 min).
 *  Reserved for REAL polling (stage 5) — `CRON_INTERVAL_MIN`; the load demo now uses
 *  `demoTickMs` (seconds). No live caller yet (planFetches has no timer until
 *  accounts are stored); kept + tested so stage 5 wires straight in. */
export function cronIntervalMs(minutes: number): number {
  const m = Number.isFinite(minutes) && minutes > 0 ? minutes : 5
  return Math.max(1, m) * 60_000
}

/** Demo enqueue cadence in ms — SECONDS-based (unlike real polling's minutes), so
 *  the load demo produces a steady, visible stream. Default 5s, floored to 1s so it
 *  never busy-loops. */
export function demoTickMs(sec: number): number {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 5
  return Math.max(1, s) * 1000
}

/** Artificial per-job processing delay (ms) for the load demo, so the queues show a
 *  visible backlog on the chart instead of draining to ~0 instantly. Clamped to
 *  [0, 5000]; default 600. Applied ONLY to demo accounts (isDemoAccount) — real jobs
 *  are never slowed. `0` disables the delay (jobs drain instantly again). */
export function demoDelayMs(ms: number): number {
  const n = Number.isFinite(ms) ? Math.floor(ms) : 600
  return Math.min(5000, Math.max(0, n))
}

/** Real cron plan: one fetch job per (portal, account) for the given window. Pure. `epoch`
 *  (a per-tick token, A10) rides on each job so a repeated poll of the same account/window is
 *  a DISTINCT job that actually re-fetches (see FetchJob.epoch); omit it for a one-shot plan. */
export function planFetches(
  accountsByPortal: { memberId: string, providerId: BankProviderId, accounts: string[] }[],
  dateFrom: string,
  dateTo: string,
  epoch?: string
): FetchJob[] {
  return accountsByPortal.flatMap(p =>
    p.accounts.map(account => ({ memberId: p.memberId, providerId: p.providerId, account, dateFrom, dateTo, ...(epoch ? { epoch } : {}) }))
  )
}

/** Providers whose online-fetch transport is LIVE (A5/A9). Prior's async create+poll is
 *  A5b — not yet wired — so we don't enqueue prior jobs that would only throw+retry. */
export const POLLABLE_PROVIDERS: ReadonlySet<BankProviderId> = new Set<BankProviderId>(['alfa-by'])

/** Group connected bank accounts (A6 registry) into the poll planner's shape: one entry per
 *  (portal, provider) with its deduped account list. Filters to POLLABLE_PROVIDERS and drops
 *  any demo account (belt-and-braces — demo accounts never reach the token store). Pure. */
export function accountsForPolling(
  refs: BankAccountRef[]
): { memberId: string, providerId: BankProviderId, accounts: string[] }[] {
  const groups = new Map<string, { memberId: string, providerId: BankProviderId, accounts: string[] }>()
  for (const ref of refs) {
    if (!POLLABLE_PROVIDERS.has(ref.provider)) continue
    if (isDemoAccount(ref.accountKey)) continue
    const key = `${ref.memberId}|${ref.provider}`
    let g = groups.get(key)
    if (!g) {
      g = { memberId: ref.memberId, providerId: ref.provider, accounts: [] }
      groups.set(key, g)
    }
    if (!g.accounts.includes(ref.accountKey)) g.accounts.push(ref.accountKey)
  }
  return [...groups.values()]
}

/** Statement window to poll: `[today − lookbackDays, today]` as ISO `YYYY-MM-DD`. A small
 *  lookback (default 1) re-covers days where operations post late. Pure (date from `now`). */
export function pollWindow(now: Date, lookbackDays = 1): { dateFrom: string, dateTo: string } {
  const dateTo = now.toISOString().slice(0, 10)
  const from = new Date(now.getTime() - Math.max(0, Math.floor(lookbackDays)) * 86_400_000)
  return { dateFrom: from.toISOString().slice(0, 10), dateTo }
}

/** Marks an account as belonging to the load demo (handler emits synthetic ops). */
export const DEMO_ACCOUNT_PREFIX = 'DEMO-'

/** True for a synthetic load-demo account. The live CRM transports gate on this so
 *  the demo load never writes to a real portal's CRM. */
export function isDemoAccount(account: string): boolean {
  return account.startsWith(DEMO_ACCOUNT_PREFIX)
}

/** Build N synthetic fetch jobs for the load demo. `tick` (a per-tick token, e.g.
 *  a timestamp) is folded into the account so each tick produces fresh jobIds —
 *  otherwise the deterministic jobId would dedupe repeated ticks into a no-op and
 *  the demo would only run once. Real polling uses planFetches() (stable ids). */
export function buildDemoFetchJobs(memberId: string, n: number, today: string, tick: string): FetchJob[] {
  const count = Math.max(0, Math.floor(n))
  return Array.from({ length: count }, (_, i) => ({
    memberId,
    providerId: 'manual' as BankProviderId,
    account: `${DEMO_ACCOUNT_PREFIX}${tick}-${i + 1}`,
    dateFrom: today,
    dateTo: today
  }))
}

/** Synthetic operations for a demo fetch job — a couple of ops so the batch flows
 *  on to crm-sync. Deterministic (docId from the account) so retries dedupe. */
export function demoItems(job: FetchJob): StatementItem[] {
  if (!isDemoAccount(job.account)) return []
  const mk = (n: number, direction: 'credit' | 'debit'): StatementItem => ({
    account: job.account,
    docId: `${job.account}-${n}`,
    direction,
    amount: 100 * n,
    currency: 'BYN',
    purpose: `Демо-операция ${n}`,
    counterparty: { name: `Демо-контрагент ${n}`, unp: `10000000${n}`, account: `BY00DEMO${n}` },
    acceptDate: `${job.dateFrom}T00:00:00.000Z`
  })
  return [mk(1, 'credit'), mk(2, 'debit')]
}
