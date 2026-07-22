import { afterEach, describe, expect, it } from 'vitest'
import {
  QUEUE_NAMES,
  Q_EVENTS,
  Q_FETCH,
  Q_PARSE,
  Q_CRM,
  Q_DELETIONS,
  Q_FEEDBACK,
  crmSyncJobId,
  deletionJobId,
  eventJobId,
  feedbackPostJobId,
  fetchJobId,
  parseJobId,
  type CrmSyncJob,
  type DeletionJob,
  type EventJob,
  type FeedbackPostJob,
  type FetchJob,
  type ParseJob
} from '../server/queue/topology'
import { connectionOptions, redisUrl } from '../server/queue/connection'

describe('queue names', () => {
  it('are the six pipeline queues, unique', () => {
    expect(QUEUE_NAMES).toEqual([Q_EVENTS, Q_FETCH, Q_PARSE, Q_CRM, Q_DELETIONS, Q_FEEDBACK])
    expect(new Set(QUEUE_NAMES).size).toBe(6)
  })
})

describe('feedbackPostJobId', () => {
  it('is member|hash so a double-submitted identical issue dedups', () => {
    const job: FeedbackPostJob = { memberId: 'M1', kind: 'up', payload: { title: 't', body: 'b', labels: [] }, contentHash: 'abc' }
    expect(feedbackPostJobId(job)).toBe('fb|M1|abc')
    expect(feedbackPostJobId({ ...job, contentHash: 'def' })).not.toBe(feedbackPostJobId(job))
  })
})

describe('deletionJobId', () => {
  it('is member|event|id|ts so a redelivered deletion dedups', () => {
    const job: DeletionJob = { memberId: 'M1', domain: 'd', eventCode: 'ONCRMDEALDELETE', entityId: '15', ts: '100' }
    expect(deletionJobId(job)).toBe('del|M1|ONCRMDEALDELETE|15|100')
    // a different entity / ts is a distinct job
    expect(deletionJobId({ ...job, entityId: '16' })).not.toBe(deletionJobId(job))
    expect(deletionJobId({ ...job, ts: '101' })).not.toBe(deletionJobId(job))
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
  it('encode parts so a value with the separator cannot collide across fields', () => {
    const a = fetchJobId({ ...fetchJob, account: 'a|b', dateFrom: 'c' })
    const b = fetchJobId({ ...fetchJob, account: 'a', dateFrom: 'b|c' })
    expect(a).not.toBe(b)
  })
  it('epoch: absent → id byte-identical to the pre-epoch id (demo/manual ids unchanged)', () => {
    // The base (no-epoch) id MUST stay stable so existing demo/manual jobs keep their ids.
    expect(fetchJobId(fetchJob)).toBe('fetch|M1|alfa-by|BY00|2026-07-01|2026-07-31')
    expect(fetchJobId({ ...fetchJob, epoch: undefined })).toBe(fetchJobId(fetchJob))
  })
  it('epoch: present → distinct id per tick (so a same-window re-poll actually re-runs)', () => {
    const t1 = fetchJobId({ ...fetchJob, epoch: '1000' })
    const t2 = fetchJobId({ ...fetchJob, epoch: '2000' })
    expect(t1).not.toBe(t2)
    expect(t1).not.toBe(fetchJobId(fetchJob)) // and distinct from the base id
    expect(t1).toBe('fetch|M1|alfa-by|BY00|2026-07-01|2026-07-31|1000')
  })
  it('event/parse ids carry their kind prefix and key fields', () => {
    const ev: EventJob = { memberId: 'M1', domain: 'p.bitrix24.by', kind: 'ONAPPINSTALL', ts: '123' }
    expect(eventJobId(ev)).toBe('evt|M1|ONAPPINSTALL|123')
    const pj: ParseJob = { memberId: 'M1', providerId: 'manual', fileName: 'a.txt', contentBase64: 'AAAA', fileHash: 'h1' }
    expect(parseJobId(pj)).toBe('parse|M1|h1')
    // Only memberId + fileHash form the id — same content (hash) dedups regardless of name/bytes.
    expect(parseJobId(pj)).toBe(parseJobId({ ...pj, fileName: 'other.txt', contentBase64: 'BBBB' }))
  })
  it('crm-sync id is memberId + batchId (items do not affect it)', () => {
    const base: CrmSyncJob = { memberId: 'M1', providerId: 'alfa-by', source: 'fetch', batchId: 'b1', items: [] }
    expect(crmSyncJobId(base)).toBe('crm|M1|b1')
    expect(crmSyncJobId(base)).toBe(crmSyncJobId({ ...base, items: [{} as never] }))
  })
  it('never contain ":" — BullMQ forbids it in a custom job id', () => {
    // Real portal member_ids/domains, and values that themselves contain a colon.
    const ev: EventJob = { memberId: '2dc4fbbc1aec6851af75358df76d53e9', domain: 'x.bitrix24.ru', kind: 'ONAPPINSTALL', ts: '1' }
    const pj: ParseJob = { memberId: 'M:1', providerId: 'manual', fileName: 'r.txt', contentBase64: 'Cg==', fileHash: 'h:2' }
    const cj: CrmSyncJob = { memberId: 'M1', providerId: 'alfa-by', source: 'fetch', batchId: 'b:3', items: [] }
    for (const id of [eventJobId(ev), fetchJobId(fetchJob), parseJobId(pj), crmSyncJobId(cj)]) {
      expect(id).not.toContain(':')
    }
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

describe('connectionOptions', () => {
  const saved = process.env.REDIS_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = saved
  })
  it('parses host/port and always sets maxRetriesPerRequest: null (BullMQ)', () => {
    process.env.REDIS_URL = 'redis://redis:6379'
    expect(connectionOptions()).toEqual({ host: 'redis', port: 6379, maxRetriesPerRequest: null })
  })
  it('defaults the port to 6379 when the URL omits it', () => {
    process.env.REDIS_URL = 'redis://cache'
    expect(connectionOptions()).toMatchObject({ host: 'cache', port: 6379 })
  })
  it('parses credentials and db index', () => {
    process.env.REDIS_URL = 'redis://user:p%40ss@host:6380/2'
    expect(connectionOptions()).toEqual({
      host: 'host', port: 6380, username: 'user', password: 'p@ss', db: 2, maxRetriesPerRequest: null
    })
  })
  it('enables TLS for rediss://', () => {
    process.env.REDIS_URL = 'rediss://host:6379'
    expect(connectionOptions()).toMatchObject({ tls: {} })
  })
})
