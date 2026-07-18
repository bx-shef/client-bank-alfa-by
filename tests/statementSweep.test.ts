import { describe, expect, it } from 'vitest'
import {
  MAX_SWEEP_INTERVAL_MIN,
  SWEEP_COMPLETED_GRACE_MS,
  SWEEP_FAILED_GRACE_MS,
  SWEPT_QUEUES,
  runStatementSweep,
  sweepIntervalMs,
  sweepPlan,
  type SweepDeps,
  type SweptQueue
} from '../server/queue/statementSweep'
import { STATEMENT_JOB_RETENTION } from '../server/queue/producers'

describe('sweepIntervalMs', () => {
  it('defaults to 30 min for a non-finite/non-positive value', () => {
    expect(sweepIntervalMs(Number.NaN)).toBe(30 * 60_000)
    expect(sweepIntervalMs(0)).toBe(30 * 60_000)
    expect(sweepIntervalMs(-5)).toBe(30 * 60_000)
  })
  it('floors to whole minutes and honours a valid value', () => {
    expect(sweepIntervalMs(10.9)).toBe(10 * 60_000)
    expect(sweepIntervalMs(1)).toBe(60_000)
  })
  it('upper-clamps below setInterval overflow (< 2^31-1 ms)', () => {
    const ms = sweepIntervalMs(1_000_000)
    expect(ms).toBe(MAX_SWEEP_INTERVAL_MIN * 60_000)
    expect(ms).toBeLessThan(2_147_483_647)
  })
})

describe('grace periods derive from STATEMENT_JOB_RETENTION (same cutoff, eager)', () => {
  it('completed grace = removeOnComplete.age × 1000', () => {
    expect(SWEEP_COMPLETED_GRACE_MS).toBe(STATEMENT_JOB_RETENTION.removeOnComplete.age * 1000)
  })
  it('failed grace = removeOnFail.age × 1000 (kept longer)', () => {
    expect(SWEEP_FAILED_GRACE_MS).toBe(STATEMENT_JOB_RETENTION.removeOnFail.age * 1000)
    expect(SWEEP_FAILED_GRACE_MS).toBeGreaterThan(SWEEP_COMPLETED_GRACE_MS)
  })
})

describe('sweepPlan', () => {
  it('covers both statement queues × completed+failed with the right grace', () => {
    const plan = sweepPlan()
    expect(plan).toEqual([
      { queue: 'file-parse', type: 'completed', graceMs: SWEEP_COMPLETED_GRACE_MS },
      { queue: 'file-parse', type: 'failed', graceMs: SWEEP_FAILED_GRACE_MS },
      { queue: 'crm-sync', type: 'completed', graceMs: SWEEP_COMPLETED_GRACE_MS },
      { queue: 'crm-sync', type: 'failed', graceMs: SWEEP_FAILED_GRACE_MS }
    ])
  })
  it('only sweeps the two PII queues (not b24-events / bank-fetch)', () => {
    expect([...SWEPT_QUEUES]).toEqual(['file-parse', 'crm-sync'])
  })
})

/** Recording fake: captures every clean call and returns a configurable removed-id list. */
function makeDeps(overrides: Partial<SweepDeps> = {}) {
  const calls: Array<{ queue: SweptQueue, graceMs: number, type: 'completed' | 'failed' }> = []
  const logs: string[] = []
  const warns: string[] = []
  const deps: SweepDeps = {
    clean: async (queue, graceMs, type) => {
      calls.push({ queue, graceMs, type })
      // Return one id per (queue,type) so counts are distinguishable.
      return [`${queue}:${type}:1`]
    },
    log: m => logs.push(m),
    warn: m => warns.push(m),
    ...overrides
  }
  return { deps, calls, logs, warns }
}

describe('runStatementSweep', () => {
  it('cleans both queues × both types and sums removed counts', async () => {
    const { deps, calls } = makeDeps()
    const s = await runStatementSweep(deps)
    expect(calls).toHaveLength(4)
    expect(s).toEqual({ completedRemoved: 2, failedRemoved: 2, failed: 0 })
  })

  it('passes the retention-derived grace to each clean call', async () => {
    const { deps, calls } = makeDeps()
    await runStatementSweep(deps)
    for (const c of calls) {
      const expected = c.type === 'completed' ? SWEEP_COMPLETED_GRACE_MS : SWEEP_FAILED_GRACE_MS
      expect(c.graceMs).toBe(expected)
    }
  })

  it('isolates a per-queue clean rejection into `failed` without aborting the rest', async () => {
    const { deps, warns } = makeDeps({
      clean: async (queue, _graceMs, type) => {
        if (queue === 'file-parse' && type === 'completed') throw new Error('Redis blip')
        return [`${queue}:${type}:1`]
      }
    })
    const s = await runStatementSweep(deps)
    // The three surviving calls still ran; only the one throw is counted.
    expect(s.failed).toBe(1)
    expect(s.completedRemoved).toBe(1) // only crm-sync completed
    expect(s.failedRemoved).toBe(2) // both failed cleans ran
    expect(warns.some(w => w.includes('file-parse/completed'))).toBe(true)
  })

  it('accumulates multi-id removals across queues (removed.length, not call count)', async () => {
    const { deps } = makeDeps({
      clean: async (queue, _graceMs, type) => {
        if (queue === 'crm-sync' && type === 'completed') return ['a', 'b', 'c']
        if (type === 'completed') return ['x'] // file-parse completed → 1
        return [] // failed sets empty this run
      }
    })
    const s = await runStatementSweep(deps)
    expect(s.completedRemoved).toBe(4) // 3 (crm-sync) + 1 (file-parse)
    expect(s.failedRemoved).toBe(0)
    expect(s.failed).toBe(0)
  })

  it('counts zero when nothing is old enough (empty removals, steady state)', async () => {
    const { deps } = makeDeps({ clean: async () => [] })
    const s = await runStatementSweep(deps)
    expect(s).toEqual({ completedRemoved: 0, failedRemoved: 0, failed: 0 })
  })

  it('when every clean throws, counts all as failed and still resolves (never rejects)', async () => {
    const { deps } = makeDeps({
      clean: async () => {
        throw new Error('Redis down')
      }
    })
    const s = await runStatementSweep(deps)
    expect(s).toEqual({ completedRemoved: 0, failedRemoved: 0, failed: 4 })
  })

  it('emits a summary log line', async () => {
    const { deps, logs } = makeDeps()
    await runStatementSweep(deps)
    expect(logs.some(l => l.startsWith('[sweep] statement queues:'))).toBe(true)
  })
})
