import { afterEach, describe, expect, it } from 'vitest'
import {
  QUEUE_NAMES,
  Q_EVENTS,
  Q_FETCH,
  Q_PARSE,
  Q_CRM,
  crmSyncJobId,
  eventJobId,
  fetchJobId,
  parseJobId,
  type CrmSyncJob,
  type EventJob,
  type FetchJob,
  type ParseJob
} from '../server/queue/topology'
import { redisUrl } from '../server/queue/connection'

describe('queue names', () => {
  it('are the four pipeline queues, unique', () => {
    expect(QUEUE_NAMES).toEqual([Q_EVENTS, Q_FETCH, Q_PARSE, Q_CRM])
    expect(new Set(QUEUE_NAMES).size).toBe(4)
  })
})

const fetchJob: FetchJob = {
  memberId: 'M1', providerId: 'alfa-by', account: 'BY00', dateFrom: '2026-07-01', dateTo: '2026-07-31'
}

describe('job ids (idempotency)', () => {
  it('are deterministic — same input, same id (dedups retries)', () => {
    expect(fetchJobId(fetchJob)).toBe(fetchJobId({ ...fetchJob }))
  })
  it('differ when any field differs', () => {
    expect(fetchJobId(fetchJob)).not.toBe(fetchJobId({ ...fetchJob, account: 'BY99' }))
    expect(fetchJobId(fetchJob)).not.toBe(fetchJobId({ ...fetchJob, dateTo: '2026-08-01' }))
  })
  it('encode parts so a value with a colon cannot collide across fields', () => {
    const a = fetchJobId({ ...fetchJob, account: 'a:b', dateFrom: 'c' })
    const b = fetchJobId({ ...fetchJob, account: 'a', dateFrom: 'b:c' })
    expect(a).not.toBe(b)
  })
  it('event/parse ids carry their kind prefix and key fields', () => {
    const ev: EventJob = { memberId: 'M1', domain: 'p.bitrix24.by', kind: 'ONAPPINSTALL', ts: '123' }
    expect(eventJobId(ev)).toBe('evt:M1:ONAPPINSTALL:123')
    const pj: ParseJob = { memberId: 'M1', providerId: 'manual', fileRef: 'k', fileHash: 'h1' }
    expect(parseJobId(pj)).toBe('parse:M1:h1')
    // fileRef is not part of the id — the same content (hash) dedups regardless of ref.
    expect(parseJobId(pj)).toBe(parseJobId({ ...pj, fileRef: 'other' }))
  })
  it('crm-sync id is memberId + batchId (items do not affect it)', () => {
    const base: CrmSyncJob = { memberId: 'M1', providerId: 'alfa-by', source: 'fetch', batchId: 'b1', items: [] }
    expect(crmSyncJobId(base)).toBe('crm:M1:b1')
    expect(crmSyncJobId(base)).toBe(crmSyncJobId({ ...base, items: [{} as never] }))
  })
})

describe('redisUrl guard', () => {
  const saved = process.env.REDIS_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = saved
  })
  it('throws when REDIS_URL is unset', () => {
    delete process.env.REDIS_URL
    expect(() => redisUrl()).toThrow(/REDIS_URL/)
  })
  it('returns the trimmed DSN when set', () => {
    process.env.REDIS_URL = '  redis://redis:6379  '
    expect(redisUrl()).toBe('redis://redis:6379')
  })
})
