import { describe, expect, it, vi } from 'vitest'
import { checkQueueToken, readQueueCounts } from '../server/queue/stats'
import { QUEUE_NAMES } from '../server/queue/topology'

describe('checkQueueToken (header-only diagnostics guard)', () => {
  it('accepts only the exact expected token', () => {
    expect(checkQueueToken('secret', 'secret')).toBe(true)
    expect(checkQueueToken('secret', 'nope')).toBe(false)
    expect(checkQueueToken('secret', 'secre')).toBe(false)
  })
  it('denies when the expected token is empty (fail-closed)', () => {
    expect(checkQueueToken('', '')).toBe(false)
    expect(checkQueueToken('', 'anything')).toBe(false)
  })
})

describe('readQueueCounts', () => {
  it('returns { enabled: false } and no queues when the bus is off', async () => {
    const countsOf = vi.fn(async () => ({}))
    const snap = await readQueueCounts(() => false, countsOf)
    expect(snap).toEqual({ enabled: false, queues: {} })
    expect(countsOf).not.toHaveBeenCalled()
  })

  it('reads counts for every queue when enabled', async () => {
    const countsOf = vi.fn(async (name: string) => ({ waiting: name.length }))
    const snap = await readQueueCounts(() => true, countsOf)
    expect(snap.enabled).toBe(true)
    expect(Object.keys(snap.queues)).toEqual([...QUEUE_NAMES])
    expect(countsOf).toHaveBeenCalledTimes(QUEUE_NAMES.length)
    // per-queue payload is passed through verbatim
    expect(snap.queues[QUEUE_NAMES[0]!]).toEqual({ waiting: QUEUE_NAMES[0]!.length })
  })
})
