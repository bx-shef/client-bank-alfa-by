import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STALL_BUDGET_MS, FAILURE_ALERT_THRESHOLD, STALL_BUDGET_MS,
  evaluateQueueHealth, stallBudgetMs, type QueueHealthInput
} from '../server/utils/queueAlert'
import { QUEUE_NAMES } from '../server/queue/topology'

// Alerting core (#426, port from ai-price-import). What these tests protect is not the arithmetic —
// it is the two failure modes the design exists to avoid: a green screen during a total outage, and
// a channel so noisy nobody reads it when it finally matters.

const q = (over: Partial<QueueHealthInput> & { queue: string }): QueueHealthInput => ({
  oldestPendingAgeMs: null, pending: 0, recentFailures: 0, ...over
})

const MIN = 60_000

describe('evaluateQueueHealth', () => {
  it('healthy pipeline produces no alerts', () => {
    expect(evaluateQueueHealth([q({ queue: 'crm-sync', pending: 900, oldestPendingAgeMs: 30_000 })])).toEqual([])
  })

  it('an unreadable queue is reported — never rendered as empty-and-healthy', () => {
    // The most dangerous lie in the whole design: stats.ts answers a dead Redis with zeros, so a
    // total outage would otherwise look like an idle, healthy pipeline.
    const out = evaluateQueueHealth([q({ queue: 'crm-sync', unreadable: true })])
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('unreadable')
  })

  it('unreadable suppresses the other verdicts (no data ⇒ no invented judgement)', () => {
    const out = evaluateQueueHealth([q({ queue: 'crm-sync', unreadable: true, oldestPendingAgeMs: 99 * 60 * MIN, recentFailures: 50 })])
    expect(out.map(a => a.kind)).toEqual(['unreadable'])
  })

  it('stall fires on the oldest job age, not on backlog size (a quiet queue can stall too)', () => {
    const out = evaluateQueueHealth([q({ queue: 'crm-sync', pending: 1, oldestPendingAgeMs: 25 * MIN })])
    expect(out.map(a => a.kind)).toEqual(['stalled'])
    expect(out[0]!.text).toContain('crm-sync')
  })

  it('a big but FRESH backlog is silent (draining normally is not a fault)', () => {
    expect(evaluateQueueHealth([q({ queue: 'crm-sync', pending: 5000, oldestPendingAgeMs: 60_000 })])).toEqual([])
  })

  it('failing fires at the threshold and is NOT also reported as a stall', () => {
    const out = evaluateQueueHealth([q({ queue: 'file-parse', recentFailures: FAILURE_ALERT_THRESHOLD })])
    expect(out.map(a => a.kind)).toEqual(['failing'])
  })

  it('below the threshold stays silent', () => {
    expect(evaluateQueueHealth([q({ queue: 'file-parse', recentFailures: FAILURE_ALERT_THRESHOLD - 1 })])).toEqual([])
  })

  it('a stalled AND failing queue reports both (different actions)', () => {
    const out = evaluateQueueHealth([q({ queue: 'crm-sync', oldestPendingAgeMs: 25 * MIN, pending: 4, recentFailures: 9 })])
    expect(out.map(a => a.kind)).toEqual(['stalled', 'failing'])
  })

  it('long ages read as hours, not as «380 мин»', () => {
    const out = evaluateQueueHealth([q({ queue: 'bank-fetch', pending: 3, oldestPendingAgeMs: 7 * 60 * MIN })])
    expect(out[0]!.text).toContain('7 ч')
  })

  it('declines the Russian counts — «1 задача ждёт», not «1 задач ждут»', () => {
    // Caught by the live smoke, not by a unit test: the alert text is the whole product here, and
    // a message that reads as machine output is one the reader trusts less.
    const one = evaluateQueueHealth([q({ queue: 'crm-sync', pending: 1, oldestPendingAgeMs: 25 * MIN })])
    expect(one[0]!.text).toContain('1 задача ждёт')
    const few = evaluateQueueHealth([q({ queue: 'crm-sync', pending: 3, oldestPendingAgeMs: 25 * MIN })])
    expect(few[0]!.text).toContain('3 задачи ждут')
    const many = evaluateQueueHealth([q({ queue: 'crm-sync', pending: 11, oldestPendingAgeMs: 25 * MIN })])
    expect(many[0]!.text).toContain('11 задач ждут')
    // 21, not 1: the failing rule only fires at FAILURE_ALERT_THRESHOLD (3), so the singular form
    // is reachable only at 21/31/… — which is exactly the case a naive «${n} задач» gets wrong.
    expect(evaluateQueueHealth([q({ queue: 'crm-sync', recentFailures: 21 })])[0]!.text).toContain('21 задача исчерпала')
    expect(evaluateQueueHealth([q({ queue: 'crm-sync', recentFailures: 5 })])[0]!.text).toContain('5 задач исчерпали')
    expect(evaluateQueueHealth([q({ queue: 'crm-sync', recentFailures: 3 })])[0]!.text).toContain('3 задачи исчерпали')
  })
})

describe('per-queue stall budgets (#426 — the domain divergence from the source port)', () => {
  it('covers every queue in the topology (a new queue cannot silently miss alerting)', () => {
    for (const name of QUEUE_NAMES) expect(name in STALL_BUDGET_MS).toBe(true)
  })

  it('trigger-fire is EXEMPT from the stall rule — its hours-long backoff is the design (#79)', () => {
    // A trigger job waits in `delayed` for the portal admin to register the CODE. That wait is
    // somebody else's action, not our outage; alerting on it would page us about working software.
    expect(stallBudgetMs('trigger-fire')).toBeNull()
    expect(evaluateQueueHealth([q({ queue: 'trigger-fire', pending: 2, oldestPendingAgeMs: 30 * 60 * MIN })])).toEqual([])
  })

  it('trigger-fire still reports FAILING — exhausting all 12 attempts is worth knowing', () => {
    const out = evaluateQueueHealth([q({ queue: 'trigger-fire', recentFailures: 5 })])
    expect(out.map(a => a.kind)).toEqual(['failing'])
  })

  it('bank-fetch tolerates a long sweep — the poller is rate-capped BY DESIGN (A8)', () => {
    // A flat 20-minute threshold (the source's single constant) would page constantly at
    // marketplace scale, where a full sweep legitimately takes hours.
    expect(evaluateQueueHealth([q({ queue: 'bank-fetch', pending: 400, oldestPendingAgeMs: 90 * MIN })])).toEqual([])
    expect(evaluateQueueHealth([q({ queue: 'bank-fetch-prior', pending: 400, oldestPendingAgeMs: 90 * MIN })])).toEqual([])
  })

  it('…but a bank queue that is truly dead still surfaces eventually', () => {
    const out = evaluateQueueHealth([q({ queue: 'bank-fetch', pending: 400, oldestPendingAgeMs: 8 * 60 * MIN })])
    expect(out.map(a => a.kind)).toEqual(['stalled'])
  })

  it('feedback-post tolerates its ~1h retry backoff but not a full stall', () => {
    expect(evaluateQueueHealth([q({ queue: 'feedback-post', pending: 1, oldestPendingAgeMs: 70 * MIN })])).toEqual([])
    const out = evaluateQueueHealth([q({ queue: 'feedback-post', pending: 1, oldestPendingAgeMs: 3 * 60 * MIN })])
    expect(out.map(a => a.kind)).toEqual(['stalled'])
  })

  it('fast paths keep the tight budget — a stalled b24-events means portals lose tokens silently', () => {
    const out = evaluateQueueHealth([q({ queue: 'b24-events', pending: 1, oldestPendingAgeMs: 25 * MIN })])
    expect(out.map(a => a.kind)).toEqual(['stalled'])
  })

  it('an unknown queue gets a generous but NON-null default (never invisible to alerting)', () => {
    expect(stallBudgetMs('some-future-queue')).toBe(DEFAULT_STALL_BUDGET_MS)
    const out = evaluateQueueHealth([q({ queue: 'some-future-queue', pending: 1, oldestPendingAgeMs: 3 * 60 * MIN })])
    expect(out.map(a => a.kind)).toEqual(['stalled'])
  })
})
