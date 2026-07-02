import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  handleCrmSyncJob, handleEventJob, handleFetchJob, handleParseJob, type HandlerDeps
} from '../server/queue/handlers'
import {
  DEMO_ACCOUNT_PREFIX, buildDemoFetchJobs, cronIntervalMs, demoItems, isDemoAccount, planFetches
} from '../server/queue/cron'
import type { CrmSyncJob, FetchJob } from '../server/queue/topology'

function item(docId: string, direction: 'credit' | 'debit' = 'credit'): StatementItem {
  return {
    account: 'A', docId, direction, amount: 10, currency: 'BYN', purpose: 'p',
    counterparty: { name: 'C', unp: '1', account: 'BY1' }, acceptDate: '2026-07-01T00:00:00.000Z'
  }
}

/** Options to shape the fake CRM-side behaviour for a test. */
interface FakeOpts {
  batch?: StatementItem[]
  /** company id returned by findCompany (default 'CO'); null = unmatched. */
  company?: string | null
  /** dedup keys already written (getActivityId returns a stored id for these). */
  alreadyWritten?: Set<string>
}

/** Recording fake deps; fetchStatement/parseFile return the given batch. By default
 *  findCompany matches a company and writeActivity mints a sequential activity id. */
function fakeDeps(opts: FakeOpts | StatementItem[] = {}): { deps: HandlerDeps, calls: Record<string, unknown[]> } {
  const o: FakeOpts = Array.isArray(opts) ? { batch: opts } : opts
  const batch = o.batch ?? []
  const company = o.company === undefined ? 'CO' : o.company
  const written = new Map<string, string>() // dedupKey → activityId (persistent dedup)
  for (const k of o.alreadyWritten ?? []) written.set(k, `pre-${k}`)
  let nextId = 1
  const calls: Record<string, unknown[]> = { crm: [], activity: [], chat: [], del: [], save: [], remember: [], find: [] }
  const deps: HandlerDeps = {
    fetchStatement: async () => batch,
    parseFile: async () => batch,
    findCompany: async (it, memberId) => {
      calls.find.push([it.docId, memberId])
      return company
    },
    writeActivity: async (it, companyId, memberId) => {
      if (!companyId) return null // no company → no owner → nothing written
      const id = `act-${nextId++}`
      calls.activity.push([it.docId, companyId, memberId, id])
      return id
    },
    notifyChat: async (it, memberId) => {
      calls.chat.push([it.docId, memberId])
    },
    getActivityId: async (_memberId, key) => written.get(key) ?? null,
    rememberActivity: async (_memberId, key, activityId) => {
      written.set(key, activityId)
      calls.remember.push([key, activityId])
    },
    savePortal: async (job) => {
      calls.save.push(job.memberId)
    },
    deletePortal: async (m) => {
      calls.del.push(m)
    },
    enqueueCrmSync: async (job) => {
      calls.crm.push(job)
      return true
    }
  }
  return { deps, calls }
}

const CREDS = { accessToken: 'A', refreshTokenEnc: 'ENC', expiresAt: 1, applicationToken: 'T' }

describe('handleEventJob', () => {
  it('deletes portal data on uninstall (always)', async () => {
    const { deps, calls } = fakeDeps()
    const r = await handleEventJob({ memberId: 'M', domain: 'd', kind: 'ONAPPUNINSTALL', ts: '1' }, deps)
    expect(r).toEqual({ kind: 'ONAPPUNINSTALL', cleaned: true, registered: false })
    expect(calls.del).toEqual(['M'])
    expect(calls.save).toEqual([])
  })
  it('registers the portal on install (persists credentials)', async () => {
    const { deps, calls } = fakeDeps()
    const r = await handleEventJob({ memberId: 'M', domain: 'd', kind: 'ONAPPINSTALL', ts: '1', credentials: CREDS }, deps)
    expect(r).toEqual({ kind: 'ONAPPINSTALL', cleaned: false, registered: true })
    expect(calls.save).toEqual(['M'])
    expect(calls.del).toEqual([])
  })
  it('does not register an install job missing credentials', async () => {
    const { deps, calls } = fakeDeps()
    const r = await handleEventJob({ memberId: 'M', domain: 'd', kind: 'ONAPPINSTALL', ts: '1' }, deps)
    expect(r.registered).toBe(false)
    expect(calls.save).toEqual([])
  })
})

describe('handleFetchJob / handleParseJob → crm-sync', () => {
  const fetchJob: FetchJob = { memberId: 'M', providerId: 'alfa-by', account: 'ACC', dateFrom: '2026-07-01', dateTo: '2026-07-31' }
  it('chains a non-empty batch onto crm-sync with a stable batchId', async () => {
    const { deps, calls } = fakeDeps([item('d1'), item('d2')])
    const r = await handleFetchJob(fetchJob, deps)
    expect(r).toEqual({ fetched: 2, chained: true })
    expect((calls.crm[0] as CrmSyncJob).batchId).toBe('ACC:2026-07-01:2026-07-31')
    expect((calls.crm[0] as CrmSyncJob).source).toBe('fetch')
  })
  it('does not chain an empty batch', async () => {
    const { deps, calls } = fakeDeps([])
    expect(await handleFetchJob(fetchJob, deps)).toEqual({ fetched: 0, chained: false })
    expect(calls.crm).toEqual([])
  })
  it('parse uses the file hash as batchId', async () => {
    const { deps, calls } = fakeDeps([item('d1')])
    const r = await handleParseJob({ memberId: 'M', providerId: 'manual', fileRef: 'k', fileHash: 'HASH' }, deps)
    expect(r).toEqual({ parsed: 1, chained: true })
    expect((calls.crm[0] as CrmSyncJob).batchId).toBe('HASH')
  })
})

describe('handleCrmSyncJob', () => {
  const job = (items: StatementItem[]): CrmSyncJob => ({
    memberId: 'M', providerId: 'alfa-by', source: 'fetch', batchId: 'b', items
  })

  it('dedupes within the batch and writes+remembers+notifies per unique op', async () => {
    const { deps, calls } = fakeDeps()
    const r = await handleCrmSyncJob(
      job([item('d1', 'credit'), item('d1', 'credit'), item('d2', 'debit')]), // d1 duplicated
      deps
    )
    expect(r).toEqual({ processed: 2, created: 2, skipped: 0, unmatched: 0, credits: 1, debits: 1 })
    expect(calls.activity).toEqual([['d1', 'CO', 'M', 'act-1'], ['d2', 'CO', 'M', 'act-2']])
    expect(calls.remember).toEqual([['A|d1', 'act-1'], ['A|d2', 'act-2']])
    // All three CRM ops receive the portal memberId ('M').
    expect(calls.find).toEqual([['d1', 'M'], ['d2', 'M']])
    expect(calls.chat).toEqual([['d1', 'M'], ['d2', 'M']])
  })

  it('is idempotent across job redelivery (real round-trip through the store)', async () => {
    const { deps, calls } = fakeDeps() // the fake persists remembered keys across calls
    const j = job([item('d1'), item('d2')])
    const first = await handleCrmSyncJob(j, deps)
    expect(first).toMatchObject({ created: 2, skipped: 0, unmatched: 0 })
    // Redeliver the SAME job: everything is now remembered → all skipped, no side effects.
    const second = await handleCrmSyncJob(j, deps)
    expect(second).toEqual({ processed: 2, created: 0, skipped: 2, unmatched: 0, credits: 2, debits: 0 })
    expect(calls.activity).toHaveLength(2) // still just the first run's two writes
    expect(calls.chat).toHaveLength(2) // no re-notify on redelivery
    expect(calls.find).toHaveLength(2) // skipped ops don't even reach findCompany
  })

  it('skips ops already written (persistent dedup) — no re-write, no re-notify', async () => {
    const { deps, calls } = fakeDeps({ alreadyWritten: new Set(['A|d1']) })
    const r = await handleCrmSyncJob(job([item('d1'), item('d2')]), deps)
    expect(r).toEqual({ processed: 2, created: 1, skipped: 1, unmatched: 0, credits: 2, debits: 0 })
    // d1 was skipped BEFORE findCompany: only d2 hit findCompany/writeActivity/chat.
    expect(calls.find).toEqual([['d2', 'M']])
    expect(calls.chat).toEqual([['d2', 'M']])
    expect(calls.remember).toEqual([['A|d2', 'act-1']])
  })

  it('counts unmatched ops (no company) and does NOT remember or notify them', async () => {
    const { deps, calls } = fakeDeps({ company: null })
    const r = await handleCrmSyncJob(job([item('d1'), item('d2')]), deps)
    expect(r).toEqual({ processed: 2, created: 0, skipped: 0, unmatched: 2, credits: 2, debits: 0 })
    expect(calls.activity).toEqual([]) // nothing written
    expect(calls.remember).toEqual([]) // so nothing remembered → retried on redelivery
    expect(calls.chat).toEqual([])
  })

  it('handles a mixed batch: one skipped, one new, one unmatched (counters do not leak)', async () => {
    // d1 pre-written (skip); d2 matches a company (create); d3 has no company (unmatched).
    const { deps, calls } = fakeDeps({
      alreadyWritten: new Set(['A|d1']),
      company: null // default no-match…
    })
    // …but let d2 match: override findCompany to match only d2.
    deps.findCompany = async it => (it.docId === 'd2' ? 'CO' : null)
    const r = await handleCrmSyncJob(job([item('d1', 'credit'), item('d2', 'credit'), item('d3', 'debit')]), deps)
    expect(r).toEqual({ processed: 3, created: 1, skipped: 1, unmatched: 1, credits: 2, debits: 1 })
    expect(calls.remember).toEqual([['A|d2', 'act-1']])
    expect(calls.chat).toEqual([['d2', 'M']])
  })
})

describe('cron helpers', () => {
  it('cronIntervalMs floors bad input to a sane default', () => {
    expect(cronIntervalMs(2)).toBe(120_000)
    expect(cronIntervalMs(0)).toBe(300_000)
    expect(cronIntervalMs(Number.NaN)).toBe(300_000)
  })
  it('planFetches yields one job per (portal, account); empty when no accounts', () => {
    expect(planFetches([], '2026-07-01', '2026-07-01')).toEqual([])
    const jobs = planFetches(
      [{ memberId: 'M', providerId: 'alfa-by', accounts: ['A1', 'A2'] }], '2026-07-01', '2026-07-02'
    )
    expect(jobs.map(j => j.account)).toEqual(['A1', 'A2'])
  })
  it('isDemoAccount flags only DEMO- accounts (the live CRM gate)', () => {
    expect(isDemoAccount('DEMO-t1-1')).toBe(true)
    expect(isDemoAccount(`${DEMO_ACCOUNT_PREFIX}x`)).toBe(true)
    expect(isDemoAccount('BY13REAL')).toBe(false)
    expect(isDemoAccount('')).toBe(false)
  })
  it('buildDemoFetchJobs makes N demo jobs, demoItems emits ops only for demo accounts', () => {
    const jobs = buildDemoFetchJobs('demo-portal', 3, '2026-07-01', 't1')
    expect(jobs).toHaveLength(3)
    expect(jobs[0]!.account.startsWith(DEMO_ACCOUNT_PREFIX)).toBe(true)
    expect(demoItems(jobs[0]!)).toHaveLength(2)
    // a non-demo account yields nothing (real transport is stage 3/5)
    expect(demoItems({ ...jobs[0]!, account: 'BY-real' })).toEqual([])
  })
  it('different ticks produce distinct accounts (so each tick enqueues fresh jobs)', () => {
    const a = buildDemoFetchJobs('demo-portal', 2, '2026-07-01', 't1')
    const b = buildDemoFetchJobs('demo-portal', 2, '2026-07-01', 't2')
    expect(a.map(j => j.account)).not.toEqual(b.map(j => j.account))
  })
})

describe('producers no-op without Redis', () => {
  const saved = process.env.REDIS_URL
  afterEach(() => {
    vi.resetModules()
    if (saved === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = saved
  })
  it('return false and never touch the queue when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL
    const { enqueueEvent, enqueueFetch } = await import('../server/queue/producers')
    expect(await enqueueEvent({ memberId: 'M', domain: 'd', kind: 'ONAPPINSTALL', ts: '1' })).toBe(false)
    expect(await enqueueFetch({ memberId: 'M', providerId: 'manual', account: 'A', dateFrom: 'x', dateTo: 'y' })).toBe(false)
  })
})
