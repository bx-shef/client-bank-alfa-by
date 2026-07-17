import { afterEach, describe, expect, it, vi } from 'vitest'

// Test the HIGH fix (Reviewers 1 & 3): pingRedis must REJECT on a deadline when the ping
// never resolves — otherwise /api/ready hangs in exactly the Redis outage it exists to
// detect (BullMQ's queue.client awaits waitUntilReady, which never rejects on an unreachable
// Redis). Mock bullmq's Queue so no real Redis is needed (mirrors throughputWorkers.test.ts).
// connectionOptions() reads REDIS_URL (no real connection — bullmq is mocked).
process.env.REDIS_URL = 'redis://localhost:6379'

// Swappable ping behavior per test.
let pingImpl: () => Promise<string> = async () => 'PONG'

vi.mock('bullmq', () => ({
  Queue: class {
    get client(): Promise<{ ping: () => Promise<string> }> {
      return Promise.resolve({ ping: () => pingImpl() })
    }

    async close(): Promise<void> {}
  }
}))

const { pingRedis } = await import('../server/queue/connection')

afterEach(() => {
  pingImpl = async () => 'PONG'
})

describe('pingRedis', () => {
  it('resolves true on PONG', async () => {
    pingImpl = async () => 'PONG'
    await expect(pingRedis(1000)).resolves.toBe(true)
  })

  it('resolves false on a non-PONG reply', async () => {
    pingImpl = async () => 'nope'
    await expect(pingRedis(1000)).resolves.toBe(false)
  })

  it('rejects on the timeout when the ping never settles (no hang)', async () => {
    pingImpl = () => new Promise<string>(() => {}) // never resolves
    await expect(pingRedis(30)).rejects.toThrow('redis ping timeout')
  })
})
