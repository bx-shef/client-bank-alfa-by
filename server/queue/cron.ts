// Cron planning + a self-contained load demo — pure functions (no Redis/timers),
// so they're unit-testable. The plugin (server/plugins/queue.ts) wires them to a
// real interval and the producers.
//
// Real polling (stage 5): planFetches() turns the installed portals + their
// accounts into one fetch job per account. Until accounts are stored it yields
// nothing — so the DEMO path below is what actually exercises the pipeline now:
// each tick enqueues N synthetic fetch jobs whose handler emits demo operations,
// so you can watch load flow bank-fetch → crm-sync via GET /api/queues.

import type { BankProviderId, StatementItem } from '../../app/types/statement'
import type { FetchJob } from './topology'

/** Interval in ms from a minutes setting (clamped to a sane floor of 1 min). */
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

/** Real cron plan: one fetch job per (portal, account) for the given window.
 *  Empty until accounts are configured (stage 5). Pure. */
export function planFetches(
  accountsByPortal: { memberId: string, providerId: BankProviderId, accounts: string[] }[],
  dateFrom: string,
  dateTo: string
): FetchJob[] {
  return accountsByPortal.flatMap(p =>
    p.accounts.map(account => ({ memberId: p.memberId, providerId: p.providerId, account, dateFrom, dateTo }))
  )
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
