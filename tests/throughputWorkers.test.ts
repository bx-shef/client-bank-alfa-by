import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerDeps } from '../server/queue/handlers'

// Wiring test for startThroughputWorkers (A8): the fetch-rate limiter must be attached to Q_FETCH
// ONLY (not parse/crm-sync), and only when fetchRate is provided. Mock bullmq's Worker to capture
// the options object each queue is constructed with — no Redis needed.
// connectionOptions() reads REDIS_URL (no real connection is made — bullmq is mocked).
process.env.REDIS_URL = 'redis://localhost:6379'

const workerCalls: Array<{ name: string, opts: Record<string, unknown> }> = []
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(name: string, _fn: unknown, opts: Record<string, unknown>) {
      workerCalls.push({ name, opts })
    }

    on() {}

    async close() {}
  }
}))

const { startThroughputWorkers, crmLockTuning, CRM_LOCK_DURATION_MS, CRM_STALLED_INTERVAL_MS, CRM_MAX_STALLED_COUNT } = await import('../server/queue/worker')
const { Q_FETCH, Q_PARSE, Q_CRM } = await import('../server/queue/topology')

const deps = {} as HandlerDeps // handlers aren't invoked at construction time

afterEach(() => {
  workerCalls.length = 0
})

function optsFor(name: string) {
  return workerCalls.find(c => c.name === name)?.opts
}

describe('startThroughputWorkers rate-limiter wiring (A8)', () => {
  it('attaches the limiter to Q_FETCH only when fetchRate is given', () => {
    startThroughputWorkers(deps, { concurrency: 2, fetchRate: { max: 7, duration: 1000 } })
    expect(optsFor(Q_FETCH)).toMatchObject({ concurrency: 2, limiter: { max: 7, duration: 1000 } })
    // Parse (local CPU) and crm-sync (throttled by the SDK) must NOT get the bank limiter.
    expect(optsFor(Q_PARSE)).not.toHaveProperty('limiter')
    expect(optsFor(Q_CRM)).not.toHaveProperty('limiter')
  })

  it('omits the limiter entirely when fetchRate is absent (no accidental unlimited nor crash)', () => {
    startThroughputWorkers(deps, { concurrency: 1 })
    expect(optsFor(Q_FETCH)).not.toHaveProperty('limiter')
  })
})

describe('crm-sync stalled-reprocessing guard (#163)', () => {
  it('crmLockTuning: lock/stall window ≥ default (60s) with a single stalled recovery', () => {
    expect(crmLockTuning()).toEqual({ lockDuration: 60_000, stalledInterval: 60_000, maxStalledCount: 1 })
    // stalledInterval must not race ahead of the lock's own lifetime.
    expect(CRM_STALLED_INTERVAL_MS).toBeGreaterThanOrEqual(CRM_LOCK_DURATION_MS)
    // Well above BullMQ's 30s default so a live (REST-I/O-bound) worker isn't falsely stalled.
    expect(CRM_LOCK_DURATION_MS).toBeGreaterThan(30_000)
    expect(CRM_MAX_STALLED_COUNT).toBe(1)
  })

  it('applies the lock tuning to crm-sync ONLY (fetch/parse keep BullMQ defaults)', () => {
    startThroughputWorkers(deps, { concurrency: 1 })
    // Placement asserted against the single source (no re-hardcoded magic numbers).
    expect(optsFor(Q_CRM)).toMatchObject(crmLockTuning())
    // The spread must not drop the base worker opts.
    expect(optsFor(Q_CRM)).toHaveProperty('connection')
    for (const q of [Q_FETCH, Q_PARSE]) {
      expect(optsFor(q)).not.toHaveProperty('lockDuration')
      expect(optsFor(q)).not.toHaveProperty('maxStalledCount')
    }
  })

  it('PINS crm-sync to concurrency 1 even when QUEUE_CONCURRENCY is raised (guard would else regress)', () => {
    // Raising the shared knob scales fetch/parse but must NOT make crm-sync in-process-concurrent —
    // that would reintroduce the find→write TOCTOU the lock tuning is meant to close.
    startThroughputWorkers(deps, { concurrency: 4 })
    expect(optsFor(Q_CRM)).toMatchObject({ concurrency: 1 })
    expect(optsFor(Q_FETCH)).toMatchObject({ concurrency: 4 })
    expect(optsFor(Q_PARSE)).toMatchObject({ concurrency: 4 })
  })
})
