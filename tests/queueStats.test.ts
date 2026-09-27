import { describe, expect, it, vi } from 'vitest'
import { readQueueCounts } from '../server/queue/stats'
import { QUEUE_NAMES } from '../server/queue/topology'

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
