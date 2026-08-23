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

  it('503 when the feature is disabled (app-side gate)', async () => {
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

describe('точечный забор за выбранный день (#588)', () => {
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

  it('сегодняшний день разрешён', async () => {
    const r = await handlePollNow(deps(), { ...input, day: '2026-07-17' })
    expect(r.status).toBe(200)
  })
})
