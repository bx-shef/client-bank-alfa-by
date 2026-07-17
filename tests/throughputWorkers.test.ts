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

const { startThroughputWorkers } = await import('../server/queue/worker')
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
