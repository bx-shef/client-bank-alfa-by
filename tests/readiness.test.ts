import { describe, expect, it } from 'vitest'
import { evaluateReadiness, type ReadinessDeps } from '../server/utils/readiness'

const deps = (over: Partial<ReadinessDeps>): ReadinessDeps => ({
  checkDb: async () => true,
  redisConfigured: () => true,
  pingRedis: async () => true,
  ...over
})

describe('evaluateReadiness', () => {
  it('ok when db + redis both up', async () => {
    expect(await evaluateReadiness(deps({}))).toEqual({ ready: true, status: 'ok', checks: { db: true, redis: true } })
  })

  it('down when db is down (hard gate)', async () => {
    const r = await evaluateReadiness(deps({ checkDb: async () => false }))
    expect(r).toEqual({ ready: false, status: 'down', checks: { db: false, redis: true } })
  })

  it('degraded when db up but a configured redis is unreachable (events serve via fallback)', async () => {
    const r = await evaluateReadiness(deps({ pingRedis: async () => false }))
    expect(r).toEqual({ ready: false, status: 'degraded', checks: { db: true, redis: false } })
  })

  it('ok with redis=null (queues off) — db alone gates', async () => {
    const r = await evaluateReadiness(deps({ redisConfigured: () => false }))
    expect(r).toEqual({ ready: true, status: 'ok', checks: { db: true, redis: null } })
  })

  it('redis not pinged when not configured', async () => {
    let pinged = false
    const pingRedis = async (): Promise<boolean> => {
      pinged = true
      return true
    }
    await evaluateReadiness(deps({ redisConfigured: () => false, pingRedis }))
    expect(pinged).toBe(false)
  })

  it('a throwing db probe coerces to down (503, never 500)', async () => {
    const checkDb = async (): Promise<boolean> => {
      throw new Error('ECONNREFUSED')
    }
    const r = await evaluateReadiness(deps({ checkDb }))
    expect(r).toEqual({ ready: false, status: 'down', checks: { db: false, redis: true } })
  })

  it('a throwing redis probe coerces to degraded', async () => {
    const pingRedis = async (): Promise<boolean> => {
      throw new Error('redis gone')
    }
    const r = await evaluateReadiness(deps({ pingRedis }))
    expect(r).toEqual({ ready: false, status: 'degraded', checks: { db: true, redis: false } })
  })

  it('db-down + redis-off → down (db is the hard gate)', async () => {
    const r = await evaluateReadiness(deps({ checkDb: async () => false, redisConfigured: () => false }))
    expect(r).toEqual({ ready: false, status: 'down', checks: { db: false, redis: null } })
  })

  it('db-down + configured-redis-down → down (db wins over degraded)', async () => {
    const r = await evaluateReadiness(deps({ checkDb: async () => false, pingRedis: async () => false }))
    expect(r).toEqual({ ready: false, status: 'down', checks: { db: false, redis: false } })
  })

  it('both probes throw → down, and evaluateReadiness still resolves (Promise.all never rejects)', async () => {
    const boom = async (): Promise<boolean> => {
      throw new Error('boom')
    }
    const r = await evaluateReadiness(deps({ checkDb: boom, pingRedis: boom }))
    expect(r).toEqual({ ready: false, status: 'down', checks: { db: false, redis: false } })
  })
})
