import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MANUAL_POLL_COOLDOWN_SEC, handlePollNow, type PollNowDeps } from '../server/utils/pollNow'
import type { BankAccountRef } from '../server/utils/bankTokenStore'

const ACCOUNTS: BankAccountRef[] = [
  { memberId: 'm1', provider: 'alfa-by', accountKey: 'BY01' },
  { memberId: 'm1', provider: 'alfa-by', accountKey: 'BY02' },
  { memberId: 'm1', provider: 'prior-by', accountKey: 'BY03' } // filtered out (not pollable yet)
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
  it('enqueues one fetch job per pollable account, drops Prior/demo', async () => {
    const enqueue = vi.fn(async () => {})
    const r = await handlePollNow(deps({ enqueue }), input)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ enqueued: 2, accounts: 2, cooldownSec: 60 })
    expect(enqueue).toHaveBeenCalledTimes(2) // BY01, BY02 (alfa) — not BY03 (prior)
  })

  it('503 when the feature is disabled (app-side gate)', async () => {
    const enqueue = vi.fn(async () => {})
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
    const enqueue = vi.fn(async () => {})
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
    expect(calls.slice(1)).toEqual(['enqueue', 'enqueue'])
  })

  it('passes the account number and a now-based epoch into the fetch jobs', async () => {
    const jobs: { account: string, epoch?: string }[] = []
    const enqueue = async (job: { account: string, epoch?: string }): Promise<void> => {
      jobs.push({ account: job.account, epoch: job.epoch })
    }
    await handlePollNow(deps({ enqueue }), input)
    expect(jobs.map(j => j.account).sort()).toEqual(['BY01', 'BY02'])
    expect(jobs.every(j => j.epoch === String(Date.UTC(2026, 6, 17, 12, 0, 0)))).toBe(true)
  })

  it('exports a sane default cooldown', () => {
    expect(DEFAULT_MANUAL_POLL_COOLDOWN_SEC).toBeGreaterThanOrEqual(30)
  })
})
