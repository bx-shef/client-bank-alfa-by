import { afterEach, describe, expect, it, vi } from 'vitest'

// Privacy retention (#245): jobs whose payload carries statement content (financial PII) — the
// parsed file (file-parse) and the normalized StatementItem[] (crm-sync) — must be enqueued with
// bounded AGE-based retention so the data ages out of Redis, NOT the count-based default that keeps
// up to 1000/5000 payloads. Mock bullmq's Queue to capture the options each add() gets (no Redis).
process.env.REDIS_URL = 'redis://localhost:6379'

const adds: Array<{ name: string, opts: Record<string, unknown> }> = []
vi.mock('bullmq', () => ({
  Queue: class {
    async add(name: string, _data: unknown, opts: Record<string, unknown>) {
      adds.push({ name, opts })
    }

    async close() {}
  }
}))

const { enqueueParse, enqueueCrmSync, enqueueEvent, enqueueFetch, STATEMENT_JOB_RETENTION, CREDENTIAL_JOB_RETENTION } = await import('../server/queue/producers')

afterEach(() => {
  adds.length = 0
})

function optsFor(queue: string) {
  return adds.find(a => a.name === queue)?.opts
}

describe('STATEMENT_JOB_RETENTION (financial-PII retention, #245)', () => {
  it('is bounded by AGE on both complete and fail (data ages out, not count-capped only)', () => {
    expect(STATEMENT_JOB_RETENTION.removeOnComplete).toMatchObject({ age: expect.any(Number) })
    expect(STATEMENT_JOB_RETENTION.removeOnFail).toMatchObject({ age: expect.any(Number) })
    // Completed statement data goes stale fast; failed kept longer for debugging but still bounded.
    expect(STATEMENT_JOB_RETENTION.removeOnComplete.age).toBeLessThanOrEqual(STATEMENT_JOB_RETENTION.removeOnFail.age)
  })
})

describe('producer retention wiring', () => {
  it('crm-sync (StatementItem[] payload) gets the bounded statement retention + keeps its jobId', async () => {
    await enqueueCrmSync({ memberId: 'M', providerId: 'manual', source: 'fetch', batchId: 'b', items: [] })
    expect(optsFor('crm-sync')).toMatchObject(STATEMENT_JOB_RETENTION)
    expect(optsFor('crm-sync')).toHaveProperty('jobId') // retention spread must not drop the dedup id
  })

  it('file-parse (base64 file payload) gets the bounded statement retention + keeps its jobId', async () => {
    await enqueueParse({ memberId: 'M', providerId: 'manual', fileName: 'f', contentBase64: '', fileHash: 'h' })
    expect(optsFor('file-parse')).toMatchObject(STATEMENT_JOB_RETENTION)
    expect(optsFor('file-parse')).toHaveProperty('jobId')
  })

  it('b24-events (clear OAuth access token in payload) drops the completed job immediately (#245)', async () => {
    await enqueueEvent({ memberId: 'M', domain: 'd', kind: 'ONAPPINSTALL', ts: '1' })
    expect(optsFor('b24-events')).toMatchObject(CREDENTIAL_JOB_RETENTION)
    expect(optsFor('b24-events')!.removeOnComplete).toBe(true)
    expect(optsFor('b24-events')).toHaveProperty('jobId')
  })

  it('bank-fetch (no statement content — our account + dates) keeps the count-based default', async () => {
    await enqueueFetch({ memberId: 'M', providerId: 'manual', account: 'A', dateFrom: 'x', dateTo: 'y' })
    expect(optsFor('bank-fetch')).not.toHaveProperty('removeOnComplete')
  })
})
