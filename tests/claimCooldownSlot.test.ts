import { afterEach, describe, expect, it, vi } from 'vitest'

// Direct test of the security-critical manual-poll cooldown (#54): claimCooldownSlot must issue
// `SET cooldown:<key> 1 EX <ttl> NX` and map 'OK'→true (claimed, proceed) / null→false (cooling
// down, 429). A wrong flag or wrong-sign mapping would silently disable the cooldown → a portal
// admin could outrun the bank rate. Mock bullmq's Queue so no real Redis is needed (mirrors
// tests/pingRedis.test.ts). connectionOptions() reads REDIS_URL (no real connection).
process.env.REDIS_URL = 'redis://localhost:6379'

let setArgs: unknown[] = []
let setReturn: unknown = 'OK'

vi.mock('bullmq', () => ({
  Queue: class {
    get client(): Promise<{ set: (...args: unknown[]) => Promise<unknown> }> {
      return Promise.resolve({
        set: (...args: unknown[]) => {
          setArgs = args
          return Promise.resolve(setReturn)
        }
      })
    }

    async close(): Promise<void> {}
  }
}))

const { claimCooldownSlot } = await import('../server/queue/connection')

afterEach(() => {
  setArgs = []
  setReturn = 'OK'
})

describe('claimCooldownSlot', () => {
  it('issues SET <prefixed-key> 1 EX <ttl> NX', async () => {
    setReturn = 'OK'
    await claimCooldownSlot('manual-poll:m1', 60)
    expect(setArgs).toEqual(['cooldown:manual-poll:m1', '1', 'EX', 60, 'NX'])
  })

  it('maps OK reply → true (slot claimed, proceed)', async () => {
    setReturn = 'OK'
    expect(await claimCooldownSlot('k', 60)).toBe(true)
  })

  it('maps null → false (still cooling down)', async () => {
    setReturn = null
    expect(await claimCooldownSlot('k', 60)).toBe(false)
  })

  it('clamps a fractional/zero/negative ttl to ≥1 whole second (never EX 0)', async () => {
    setReturn = 'OK'
    await claimCooldownSlot('k', 0)
    expect(setArgs[3]).toBe(1)
    await claimCooldownSlot('k', -5)
    expect(setArgs[3]).toBe(1)
    await claimCooldownSlot('k', 60.9)
    expect(setArgs[3]).toBe(60)
  })
})
