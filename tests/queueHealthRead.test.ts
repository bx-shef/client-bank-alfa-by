import { describe, expect, it } from 'vitest'
import { QUEUE_NAMES, type QueueName } from '../server/queue/topology'
import {
  countRecentFailures, isServiceFailure, readQueueHealth, summarisePending,
  type RawFailedAt, type RawPendingJob } from '../server/utils/queueHealthRead'

// Reading side (#426). Two contracts matter here and are easy to break silently:
//  1. an unreachable queue must NOT read as empty-and-healthy;
//  2. a tenant's misconfiguration must NOT be counted as our outage.

const T0 = 1_800_000_000_000
const MIN = 60_000

describe('summarisePending', () => {
  it('reports the OLDEST age and the count', () => {
    const jobs: RawPendingJob[] = [{ timestamp: T0 - 5 * MIN }, { timestamp: T0 - 40 * MIN }, { timestamp: T0 - MIN }]
    expect(summarisePending(jobs, T0)).toEqual({ pending: 3, oldestPendingAgeMs: 40 * MIN })
  })

  it('an empty queue has no age (null, not 0 — «пусто» is not «стоит»)', () => {
    expect(summarisePending([], T0)).toEqual({ pending: 0, oldestPendingAgeMs: null })
  })

  it('a job stamped in the FUTURE (clock skew) does not read as a huge age', () => {
    expect(summarisePending([{ timestamp: T0 + 10 * MIN }], T0).oldestPendingAgeMs).toBe(0)
  })

  it('a job without a usable timestamp is counted but cannot age', () => {
    expect(summarisePending([{ timestamp: null }, {}], T0)).toEqual({ pending: 2, oldestPendingAgeMs: null })
  })
})

describe('isServiceFailure', () => {
  it.each([
    'ACCESS_DENIED',
    'Access denied',
    'insufficient_scope: userfieldconfig',
    'PAYMENT_REQUIRED',
    'invalid_grant',
    'ERROR_WRONG_CONTEXT',
    'Портал не авторизован',
    // Банк: клиент не переподключил согласие — переподключает он, не мы.
    'resolvePriorAccountId: account BY12 not found in the consent\'s account list',
    'AccountConsent expired',
    'согласие клиента истекло'
  ])('excludes the portal-side refusal %s (deterministic per tenant — not our health)', (reason) => {
    expect(isServiceFailure(reason)).toBe(false)
  })

  it('НЕ исключает голые invalid_token/expired_token — это ещё и лексика БАНКА', () => {
    // Отказ банковского транспорта по НАШИМ кредам — наша авария на всех клиентах сразу;
    // отфильтровать её значило бы ослепнуть ровно в самый громкий момент.
    expect(isServiceFailure('alfa: invalid_token')).toBe(true)
    expect(isServiceFailure('bank responded expired_token')).toBe(true)
  })

  it.each([
    'ECONNREFUSED 127.0.0.1:6379',
    'socket hang up',
    'Cannot read properties of undefined',
    ''
  ])('counts %s as OURS — unknown wording fails OPEN (a missed alert costs more)', (reason) => {
    expect(isServiceFailure(reason)).toBe(true)
  })
})

describe('countRecentFailures', () => {
  const fail = (agoMs: number, reason = 'socket hang up'): RawFailedAt => ({ finishedOn: T0 - agoMs, failedReason: reason })

  it('counts only failures inside the window', () => {
    expect(countRecentFailures([fail(5 * MIN), fail(30 * MIN), fail(120 * MIN)], T0)).toBe(2)
  })

  it('falls back to processedOn when finishedOn is missing', () => {
    expect(countRecentFailures([{ processedOn: T0 - 5 * MIN, failedReason: 'boom' }], T0)).toBe(1)
  })

  it('skips undated failures (guessing «сейчас» would raise false alarms)', () => {
    expect(countRecentFailures([{ failedReason: 'boom' }], T0)).toBe(0)
  })

  it('skips failures stamped in the future', () => {
    expect(countRecentFailures([{ finishedOn: T0 + MIN, failedReason: 'boom' }], T0)).toBe(0)
  })

  it('one misconfigured tenant cannot page us: portal-side refusals are not counted', () => {
    const portalSide = [fail(MIN, 'ACCESS_DENIED'), fail(2 * MIN, 'insufficient_scope'), fail(3 * MIN, 'PAYMENT_REQUIRED')]
    expect(countRecentFailures(portalSide, T0)).toBe(0)
  })
})

describe('readQueueHealth', () => {
  const okReader = {
    pending: async () => [{ timestamp: T0 - 2 * MIN }],
    failed: async () => []
  }

  it('reads every queue in the topology', async () => {
    const out = await readQueueHealth(okReader, T0)
    expect(out.map(o => o.queue)).toEqual([...QUEUE_NAMES])
  })

  it('an unreachable queue is marked unreadable — NOT zeroed into looking healthy', async () => {
    const out = await readQueueHealth({
      pending: async (n: QueueName) => {
        if (n === 'crm-sync') throw new Error('ECONNREFUSED')
        return []
      },
      failed: async () => []
    }, T0)
    const crm = out.find(o => o.queue === 'crm-sync')!
    expect(crm.unreadable).toBe(true)
    // The others still read — a partial reading is worth acting on.
    expect(out.filter(o => o.unreadable).length).toBe(1)
  })

  it('a failing `failed` read also marks the queue unreadable (both sides are needed)', async () => {
    const out = await readQueueHealth({
      pending: async () => [],
      failed: async (n: QueueName) => {
        if (n === 'bank-fetch') throw new Error('down')
        return []
      }
    }, T0)
    expect(out.find(o => o.queue === 'bank-fetch')!.unreadable).toBe(true)
  })
})

describe('отозванный доступ к приложению — сторона ПОРТАЛА (замер 2026-08-25)', () => {
  // ⚠ На боевом стенде у портала отозвали доступ к приложению в Маркете, и каждая его операция
  // стала падать `Subscription has been ended` — три попытки на операцию, до упора. Без этой
  // классификации такой портал считался бы НАШЕЙ поломкой и пейджил бы владельца тем, что тот
  // починить не может.
  it('НЕ засчитывается как наша поломка', () => {
    expect(isServiceFailure('Subscription has been ended')).toBe(false)
  })

  it('регистр и обрамление не мешают', () => {
    expect(isServiceFailure('Error: subscription has been ended')).toBe(false)
    expect(isServiceFailure('SUBSCRIPTION HAS BEEN ENDED')).toBe(false)
  })

  it('а настоящая наша поломка по-прежнему засчитывается', () => {
    // Иначе список превратился бы в глушилку всего подряд.
    expect(isServiceFailure('ECONNREFUSED 10.0.0.5:5432')).toBe(true)
  })
})
