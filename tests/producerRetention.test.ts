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

const { enqueueParse, enqueueCrmSync, enqueueEvent, enqueueFetch, enqueueRegistryWrite, enqueueActivityBind, STATEMENT_JOB_RETENTION, CREDENTIAL_JOB_RETENTION, FETCH_JOB_RETENTION, CRM_RETRY_RETENTION, DEFERRED_WRITE_RETRY } = await import('../server/queue/producers')

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

  it('bank-fetch REMOVES the completed job — that frees the stable jobId for the next sweep', async () => {
    // Load-bearing at marketplace scale: the cron uses a STABLE jobId per (portal, account,
    // window) so a still-pending account is never re-added (bounded queue). That only keeps
    // polling if the id is freed on completion — otherwise every account would be polled ONCE
    // and then dedup-blocked forever.
    await enqueueFetch({ memberId: 'M', providerId: 'manual', account: 'A', dateFrom: 'x', dateTo: 'y' })
    expect(optsFor('bank-fetch')).toMatchObject(FETCH_JOB_RETENTION)
    expect(optsFor('bank-fetch')!.removeOnComplete).toBe(true)
    expect(optsFor('bank-fetch')).toHaveProperty('jobId')
  })

  it('bank-fetch bounds FAILED by age — a failing account is retried, not abandoned forever', async () => {
    // A failed job keeps its id, so without an age bound the stable-id dedup would permanently
    // lock that account out of every future sweep.
    await enqueueFetch({ memberId: 'M', providerId: 'manual', account: 'A', dateFrom: 'x', dateTo: 'y' })
    const onFail = optsFor('bank-fetch')!.removeOnFail as { age: number, count: number }
    expect(onFail.age).toBeGreaterThan(0)
    expect(onFail.age).toBeLessThanOrEqual(24 * 3600)
    expect(onFail.count).toBeGreaterThan(0)
  })
})

describe('дозапись в CRM: ретрай и удержание (#578/#585)', () => {
  const item = {
    account: 'BY00', docId: 'd1', direction: 'credit' as const, amount: 1, currency: 'BYN',
    purpose: 'p', counterparty: { name: '', unp: '', account: '', bank: '' }, acceptDate: '2026-08-22T00:00:00+03:00'
  }

  it('registry-write: ретрай ЕСТЬ, удержание — как у выписки (в payload ПДн)', async () => {
    // ⚠ Мутационный прогон показал дыру: без `attempts` BullMQ берёт 1 попытку, то есть вся идея
    // «долговременной дозаписи» молча выключается, и ни один тест этого не замечал.
    await enqueueRegistryWrite({ memberId: 'M', providerId: 'alfa-by', item, companyId: null, paymentSp: { entityTypeId: 1044, id: 44 } })
    const opts = optsFor('registry-write')
    expect(opts).toMatchObject(DEFERRED_WRITE_RETRY)
    expect(opts).toMatchObject(STATEMENT_JOB_RETENTION)
    expect(opts).toHaveProperty('jobId')
  })

  it('activity-bind: тот же ретрай, но обычное удержание (ПДн в payload нет)', async () => {
    await enqueueActivityBind({ memberId: 'M', activityId: '2087', refs: [{ entityTypeId: 4, entityId: 9 }] })
    const opts = optsFor('activity-bind')
    expect(opts).toMatchObject(DEFERRED_WRITE_RETRY)
    expect(opts).toMatchObject(CRM_RETRY_RETENTION)
    expect(opts).toHaveProperty('jobId')
  })

  it('лестница ретраев — та, что описана в комментарии (≈1 час, а не «~2 часа»)', () => {
    // ⚠ Число проверяется, потому что на него ссылаются и бюджет простоя очереди, и PRIVACY.md
    // (сколько ПДн лежат в Redis). Первая редакция посчитала его неверно, и ошибка разошлась по
    // трём документам молча.
    const { attempts, backoff } = DEFERRED_WRITE_RETRY
    const total = Array.from({ length: attempts - 1 }, (_, i) => backoff.delay * 2 ** i).reduce((a, b) => a + b, 0)
    expect(total).toBe(3810_000) // ≈1 час, а не два
  })
})
