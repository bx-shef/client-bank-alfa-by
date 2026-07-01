import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  handleCrmSyncJob, handleEventJob, handleFetchJob, handleParseJob, type HandlerDeps
} from '../server/queue/handlers'
import {
  DEMO_ACCOUNT_PREFIX, buildDemoFetchJobs, cronIntervalMs, demoItems, planFetches
} from '../server/queue/cron'
import type { CrmSyncJob, FetchJob } from '../server/queue/topology'

function item(docId: string, direction: 'credit' | 'debit' = 'credit'): StatementItem {
  return {
    account: 'A', docId, direction, amount: 10, currency: 'BYN', purpose: 'p',
    counterparty: { name: 'C', unp: '1', account: 'BY1' }, acceptDate: '2026-07-01T00:00:00.000Z'
  }
}

/** Recording fake deps; fetchStatement/parseFile return the given batch. */
function fakeDeps(batch: StatementItem[] = []): { deps: HandlerDeps, calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { crm: [], activity: [], chat: [], del: [] }
  const deps: HandlerDeps = {
    fetchStatement: async () => batch,
    parseFile: async () => batch,
    findCompany: async () => null,
    writeActivity: async (it, companyId) => {
      calls.activity.push([it.docId, companyId])
    },
    notifyChat: async (it) => {
      calls.chat.push(it.docId)
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

describe('handleEventJob', () => {
  it('deletes portal data on uninstall', async () => {
    const { deps, calls } = fakeDeps()
    const r = await handleEventJob({ memberId: 'M', domain: 'd', kind: 'ONAPPUNINSTALL', ts: '1' }, deps)
    expect(r).toEqual({ kind: 'ONAPPUNINSTALL', cleaned: true })
    expect(calls.del).toEqual(['M'])
  })
  it('does not clean on install', async () => {
    const { deps, calls } = fakeDeps()
    const r = await handleEventJob({ memberId: 'M', domain: 'd', kind: 'ONAPPINSTALL', ts: '1' }, deps)
    expect(r.cleaned).toBe(false)
    expect(calls.del).toEqual([])
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
  it('dedupes within the batch (account|docId) and acts per unique op', async () => {
    const { deps, calls } = fakeDeps()
    const job: CrmSyncJob = {
      memberId: 'M', providerId: 'alfa-by', source: 'fetch', batchId: 'b',
      items: [item('d1', 'credit'), item('d1', 'credit'), item('d2', 'debit')] // d1 duplicated
    }
    const r = await handleCrmSyncJob(job, deps)
    expect(r).toEqual({ processed: 2, credits: 1, debits: 1 })
    expect(calls.activity).toHaveLength(2)
    expect(calls.chat).toEqual(['d1', 'd2'])
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
  it('buildDemoFetchJobs makes N demo jobs, demoItems emits ops only for demo accounts', () => {
    const jobs = buildDemoFetchJobs('demo-portal', 3, '2026-07-01')
    expect(jobs).toHaveLength(3)
    expect(jobs[0]!.account.startsWith(DEMO_ACCOUNT_PREFIX)).toBe(true)
    expect(demoItems(jobs[0]!)).toHaveLength(2)
    // a non-demo account yields nothing (real transport is stage 3/5)
    expect(demoItems({ ...jobs[0]!, account: 'BY-real' })).toEqual([])
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
