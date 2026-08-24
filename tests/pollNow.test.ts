import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MANUAL_POLL_COOLDOWN_SEC, handlePollNow, type PollNowDeps } from '../server/utils/pollNow'
import type { BankAccountRef } from '../server/utils/bankTokenStore'
import type { FetchJob } from '../server/queue/topology'

const ACCOUNTS: BankAccountRef[] = [
  { memberId: 'm1', provider: 'alfa-by', accountKey: 'BY01', pollPaused: false },
  { memberId: 'm1', provider: 'alfa-by', accountKey: 'BY02', pollPaused: false },
  { memberId: 'm1', provider: 'prior-by', accountKey: 'BY03', pollPaused: false }, // pollable (own queue+limiter)
  { memberId: 'm1', provider: 'manual', accountKey: 'BY04', pollPaused: false } // filtered out (no online fetch)
]

const deps = (over: Partial<PollNowDeps> = {}): PollNowDeps => ({
  enabled: true,
  cooldownSec: 60,
  lookbackDays: 1,
  memberIdByDomain: async () => 'm1',
  validateFrame: async () => ({ userId: '7', isAdmin: true }),
  listAccounts: async () => ACCOUNTS,
  claimSlot: async () => true,
  enqueue: async () => {},
  nowMs: Date.UTC(2026, 6, 17, 12, 0, 0),
  ...over
})

const input = { accessToken: 'tok', domain: 'p.bitrix24.by' }

describe('handlePollNow', () => {
  it('enqueues one fetch job per pollable account (alfa + prior), drops non-pollable', async () => {
    const enqueue = vi.fn(async (_job: FetchJob) => {})
    const r = await handlePollNow(deps({ enqueue }), input)
    expect(r.status).toBe(200)
    // BY01, BY02 (alfa) + BY03 (prior — its own queue absorbs the cost) — NOT BY04 (manual).
    expect(r.body).toMatchObject({ enqueued: 3, accounts: 3, cooldownSec: 60 })
    expect(enqueue).toHaveBeenCalledTimes(3)
    const providers = enqueue.mock.calls.map(c => (c[0] as { providerId: string }).providerId)
    expect(providers).toContain('prior-by')
    expect(providers).not.toContain('manual')
  })

  it('503 без очередей — а не молчаливое «запущено»', async () => {
    // ⚠ Своего выключателя у ручного опроса больше нет (`MANUAL_POLL_ENABLED` снят 2026-08-23):
    // кнопка нужна на каждом портале. Остаётся ровно одна причина ответить отказом — недоступные
    // очереди: постановка задачи тогда молча ничего не делает, и «опрос запущен» было бы ложью.
    const enqueue = vi.fn(async (_job: FetchJob) => {})
    const r = await handlePollNow(deps({ enabled: false, enqueue }), input)
    expect(r.status).toBe(503)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('400 without a token or domain', async () => {
    expect((await handlePollNow(deps(), { accessToken: '', domain: 'p' })).status).toBe(400)
    expect((await handlePollNow(deps(), { accessToken: 't', domain: '' })).status).toBe(400)
  })

  it('409 when the portal is not installed', async () => {
    const r = await handlePollNow(deps({ memberIdByDomain: async () => null }), input)
    expect(r.status).toBe(409)
  })

  it('403 when the frame token is invalid for the portal (throws)', async () => {
    const validateFrame = async (): Promise<{ userId: string, isAdmin: boolean }> => {
      throw new Error('bad token')
    }
    const r = await handlePollNow(deps({ validateFrame }), input)
    expect(r.status).toBe(403)
  })

  it('403 when the caller is not a portal admin', async () => {
    const r = await handlePollNow(deps({ validateFrame: async () => ({ userId: '7', isAdmin: false }) }), input)
    expect(r.status).toBe(403)
  })

  it('200 enqueued:0 with no connected accounts — and does NOT burn the cooldown', async () => {
    const claimSlot = vi.fn(async () => true)
    const r = await handlePollNow(deps({ listAccounts: async () => [], claimSlot }), input)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ enqueued: 0, accounts: 0 })
    expect(claimSlot).not.toHaveBeenCalled() // no work → no cooldown claim
  })

  it('429 when the cooldown slot is already taken', async () => {
    const enqueue = vi.fn(async (_job: FetchJob) => {})
    const r = await handlePollNow(deps({ claimSlot: async () => false, enqueue }), input)
    expect(r.status).toBe(429)
    expect(r.body).toMatchObject({ cooldownSec: 60 })
    expect(enqueue).not.toHaveBeenCalled() // cooling down → nothing enqueued
  })

  it('claims the cooldown BEFORE enqueuing (order matters)', async () => {
    const calls: string[] = []
    const claimSlot = async (): Promise<boolean> => {
      calls.push('claim')
      return true
    }
    const enqueue = async (): Promise<void> => {
      calls.push('enqueue')
    }
    await handlePollNow(deps({ claimSlot, enqueue }), input)
    expect(calls[0]).toBe('claim')
    expect(calls.slice(1)).toEqual(['enqueue', 'enqueue', 'enqueue'])
  })

  it('passes the account number and a now-based epoch into the fetch jobs', async () => {
    const jobs: { account: string, epoch?: string }[] = []
    const enqueue = async (job: { account: string, epoch?: string }): Promise<void> => {
      jobs.push({ account: job.account, epoch: job.epoch })
    }
    await handlePollNow(deps({ enqueue }), input)
    expect(jobs.map(j => j.account).sort()).toEqual(['BY01', 'BY02', 'BY03'])
    expect(jobs.every(j => j.epoch === String(Date.UTC(2026, 6, 17, 12, 0, 0)))).toBe(true)
  })

  it('exports a sane default cooldown', () => {
    expect(DEFAULT_MANUAL_POLL_COOLDOWN_SEC).toBeGreaterThanOrEqual(30)
  })
})

describe('точечный забор за выбранный день (#592)', () => {
  it('день заменяет окно ЦЕЛИКОМ — одна задача про один день', async () => {
    // ⚠ Не «расширить окно до дня», а именно заменить: «забрать за 17 августа» обязано спросить
    // банк ровно про 17 августа. Иначе запрос ушёл бы за скользящее окно, вернул сегодняшние
    // операции, и человек прочитал бы это как «за тот день у банка ничего нет».
    const enqueue = vi.fn(async (_job: FetchJob) => {})
    const r = await handlePollNow(deps({ enqueue }), { ...input, day: '2026-07-10' })
    expect(r.status).toBe(200)
    expect(r.body, 'день не подтверждён эхом — интерфейсу нечего показать').toMatchObject({ day: '2026-07-10' })
    for (const call of enqueue.mock.calls) {
      const job = call[0] as { dateFrom: string, dateTo: string }
      expect(job.dateFrom).toBe('2026-07-10')
      expect(job.dateTo).toBe('2026-07-10')
    }
  })

  it('без дня — прежнее скользящее окно, эха дня нет', async () => {
    const enqueue = vi.fn(async (_job: FetchJob) => {})
    const r = await handlePollNow(deps({ enqueue }), input)
    expect(r.body).not.toHaveProperty('day')
    const job = enqueue.mock.calls[0]?.[0] as { dateFrom: string, dateTo: string }
    expect(job.dateFrom).not.toBe(job.dateTo)
  })

  it('будущий и кривой день отвергаются ДО банка, портала и кулдауна', async () => {
    // ⚠ Порядок здесь несущий: отвергнутая дата не должна стоить ни REST-вызова к Bitrix24, ни
    // минуты паузы — иначе опечатка в календаре блокировала бы исправную кнопку на кулдаун.
    for (const bad of ['2026-07-18', '2026-02-31', 'вчера']) {
      const enqueue = vi.fn(async (_job: FetchJob) => {})
      const claimSlot = vi.fn(async () => true)
      const validateFrame = vi.fn(async () => ({ userId: '7', isAdmin: true }))
      const r = await handlePollNow(deps({ enqueue, claimSlot, validateFrame }), { ...input, day: bad })
      expect(r.status, bad).toBe(400)
      expect(String(r.body.error), bad).not.toBe('')
      expect(claimSlot, `${bad}: сожжён кулдаун`).not.toHaveBeenCalled()
      expect(validateFrame, `${bad}: сходили в портал зря`).not.toHaveBeenCalled()
      expect(enqueue, bad).not.toHaveBeenCalled()
    }
  })

  it('кулдаун применяется и к забору за день', async () => {
    // ⚠ Мутация из ревью: `if (!day) { …claimSlot… }` снимала кулдаун именно с забора за день, и
    // весь набор оставался зелёным — оба прежних теста кулдауна ходили БЕЗ дня. То есть слой,
    // который мы называем защитой от долбёжа, не был проверен там, где им пользуются.
    const enqueue = vi.fn(async (_job: FetchJob) => {})
    const r = await handlePollNow(deps({ claimSlot: async () => false, enqueue }), { ...input, day: '2026-07-10' })
    expect(r.status).toBe(429)
    expect(enqueue, 'забор за день прошёл мимо кулдауна').not.toHaveBeenCalled()
  })

  it('сегодняшний день разрешён', async () => {
    const r = await handlePollNow(deps(), { ...input, day: '2026-07-17' })
    expect(r.status).toBe(200)
  })
})

describe('#19 забор адресуется КОНКРЕТНОМУ подключению', () => {
  it('опрашивается ровно один счёт, а не все подключения портала', async () => {
    // ⚠ Без адреса «забрать за 18 августа» ставит задачу на КАЖДЫЙ счёт портала, тогда как человек
    // смотрел на конкретную строку и про неё спрашивал: лимит запросов тратится на счета, о
    // которых не спрашивали, а ответ «опрос запущен» не говорит, что именно опрошено.
    const enqueue = vi.fn(async (_job: FetchJob) => {})
    const r = await handlePollNow(deps({ enqueue }), { ...input, provider: 'alfa-by', accountKey: 'BY02' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ enqueued: 1, accounts: 1, provider: 'alfa-by', accountKey: 'BY02' })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect((enqueue.mock.calls[0]![0] as { account: string }).account).toBe('BY02')
  })

  it('БАНК — часть адреса: тот же номер у другого банка не подходит', async () => {
    // Один и тот же номер у разных банков — разные строки хранилища. Отбор по одному номеру
    // опросил бы чужое подключение, о котором не просили.
    const enqueue = vi.fn(async (_job: FetchJob) => {})
    const r = await handlePollNow(deps({ enqueue }), { ...input, provider: 'prior-by', accountKey: 'BY02' })
    expect(r.status).toBe(404)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('счёта нет — 404, а не тихое «0 задач»', async () => {
    // ⚠ «enqueued: 0» неотличимо от «портал вообще ничего не подключил», и человек, чей счёт только
    // что отключили из соседней вкладки, прочитал бы это как «опрос сработал, операций нет».
    const r = await handlePollNow(deps(), { ...input, accountKey: 'BY99', provider: 'alfa-by' })
    expect(r.status).toBe(404)
  })

  it('счёт на паузе — 409 с объяснением, а не тишина', async () => {
    const paused: BankAccountRef[] = [{ memberId: 'm1', provider: 'alfa-by', accountKey: 'BY01', pollPaused: true }]
    const r = await handlePollNow(deps({ listAccounts: async () => paused }), {
      ...input, provider: 'alfa-by', accountKey: 'BY01'
    })
    expect(r.status).toBe(409)
    expect(String(r.body.error)).toContain('паузу')
  })

  it('адрес + день работают вместе и оба возвращаются эхом', async () => {
    const enqueue = vi.fn(async (_job: FetchJob) => {})
    const r = await handlePollNow(deps({ enqueue }), {
      ...input, provider: 'alfa-by', accountKey: 'BY01', day: '2026-07-16'
    })
    expect(r.body).toMatchObject({ day: '2026-07-16', provider: 'alfa-by', accountKey: 'BY01', enqueued: 1 })
    const job = enqueue.mock.calls[0]![0] as { dateFrom: string, dateTo: string }
    expect([job.dateFrom, job.dateTo]).toEqual(['2026-07-16', '2026-07-16'])
  })

  it('без адреса поведение прежнее — все подключённые счета', async () => {
    const r = await handlePollNow(deps(), input)
    expect(r.body).toMatchObject({ enqueued: 3 })
    expect(r.body.provider).toBeUndefined()
  })

  it('ЧУЖОЙ счёт не достаётся: список member-scoped, отбор идёт уже внутри него', async () => {
    const r = await handlePollNow(deps({ listAccounts: async () => [] }), {
      ...input, provider: 'alfa-by', accountKey: 'BY01'
    })
    expect(r.status).toBe(404)
  })
})
