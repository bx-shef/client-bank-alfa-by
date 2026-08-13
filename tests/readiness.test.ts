import { describe, expect, it } from 'vitest'
import { evaluateReadiness, gatewayProbeBase, type ReadinessDeps } from '../server/utils/readiness'

const deps = (over: Partial<ReadinessDeps>): ReadinessDeps => ({
  checkDb: async () => true,
  redisConfigured: () => true,
  pingRedis: async () => true,
  // Default: no gateway in use — the common deployment (Prior straight over TLS / not connected).
  cryptoGwConfigured: () => false,
  pingCryptoGw: async () => true,
  ...over
})

describe('evaluateReadiness', () => {
  it('ok when db + redis both up', async () => {
    expect(await evaluateReadiness(deps({}))).toEqual({ ready: true, status: 'ok', checks: { db: true, redis: true, cryptoGw: null } })
  })

  it('down when db is down (hard gate)', async () => {
    const r = await evaluateReadiness(deps({ checkDb: async () => false }))
    expect(r).toEqual({ ready: false, status: 'down', checks: { db: false, redis: true, cryptoGw: null } })
  })

  it('degraded when db up but a configured redis is unreachable (events serve via fallback)', async () => {
    const r = await evaluateReadiness(deps({ pingRedis: async () => false }))
    expect(r).toEqual({ ready: false, status: 'degraded', checks: { db: true, redis: false, cryptoGw: null } })
  })

  it('ok with redis=null (queues off) — db alone gates', async () => {
    const r = await evaluateReadiness(deps({ redisConfigured: () => false }))
    expect(r).toEqual({ ready: true, status: 'ok', checks: { db: true, redis: null, cryptoGw: null } })
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
    expect(r).toEqual({ ready: false, status: 'down', checks: { db: false, redis: true, cryptoGw: null } })
  })

  it('a throwing redis probe coerces to degraded', async () => {
    const pingRedis = async (): Promise<boolean> => {
      throw new Error('redis gone')
    }
    const r = await evaluateReadiness(deps({ pingRedis }))
    expect(r).toEqual({ ready: false, status: 'degraded', checks: { db: true, redis: false, cryptoGw: null } })
  })

  it('db-down + redis-off → down (db is the hard gate)', async () => {
    const r = await evaluateReadiness(deps({ checkDb: async () => false, redisConfigured: () => false }))
    expect(r).toEqual({ ready: false, status: 'down', checks: { db: false, redis: null, cryptoGw: null } })
  })

  it('db-down + configured-redis-down → down (db wins over degraded)', async () => {
    const r = await evaluateReadiness(deps({ checkDb: async () => false, pingRedis: async () => false }))
    expect(r).toEqual({ ready: false, status: 'down', checks: { db: false, redis: false, cryptoGw: null } })
  })

  it('both probes throw → down, and evaluateReadiness still resolves (Promise.all never rejects)', async () => {
    const boom = async (): Promise<boolean> => {
      throw new Error('boom')
    }
    const r = await evaluateReadiness(deps({ checkDb: boom, pingRedis: boom }))
    expect(r).toEqual({ ready: false, status: 'down', checks: { db: false, redis: false, cryptoGw: null } })
  })

  it('gateway in use and answering → reported, verdict untouched', async () => {
    const r = await evaluateReadiness(deps({ cryptoGwConfigured: () => true }))
    expect(r).toEqual({ ready: true, status: 'ok', checks: { db: true, redis: true, cryptoGw: true } })
  })

  it('gateway DOWN does NOT make the app unready', async () => {
    // The whole design decision in one test: Priorbank is one bank out of several, and B24
    // events / manual upload / Alfa keep working. A 503 here would take the app down for every
    // uptime monitor — and restart-loop it wherever this endpoint drives a healthcheck.
    const r = await evaluateReadiness(deps({ cryptoGwConfigured: () => true, pingCryptoGw: async () => false }))
    expect(r).toEqual({ ready: true, status: 'ok', checks: { db: true, redis: true, cryptoGw: false } })
  })

  it('gateway probe that throws is reported false, not propagated', async () => {
    const r = await evaluateReadiness(deps({
      cryptoGwConfigured: () => true,
      pingCryptoGw: async () => { throw new Error('ECONNREFUSED') }
    }))
    expect(r.checks.cryptoGw).toBe(false)
    expect(r.ready).toBe(true)
  })

  it('gateway not configured → null, probe never called', async () => {
    let called = false
    const r = await evaluateReadiness(deps({
      pingCryptoGw: async () => {
        called = true
        return true
      }
    }))
    expect(r.checks.cryptoGw).toBeNull()
    expect(called).toBe(false)
  })
})

// Which address means «шлюз в работе». Previously inlined in `server/api/ready.get.ts`, where it
// had no test at all: reverting it to API-base-only (the exact #455 bug) left the whole suite
// green. These pin the reversion instead of the shape.
describe('gatewayProbeBase — «шлюз в работе» derived from the two Prior addresses', () => {
  const GW = 'http://crypto-gw:1080'
  const BANK = 'https://apibel.priorbank.by:9345'

  it('neither address internal → gateway not in use', () => {
    expect(gatewayProbeBase(BANK, `${BANK}/token`)).toBeNull()
  })

  it('API base internal → probe it', () => {
    expect(gatewayProbeBase(GW, `${BANK}/token`)).toBe(GW)
  })

  // The regression that matters: the documented production shape is the TOKEN endpoint behind the
  // gateway while the resource API stays on the bank's public host. Looking only at the API base
  // reports «шлюз не используется» while every token refresh goes through it.
  it('only the token URL is internal → still in use, probed at its ORIGIN', () => {
    expect(gatewayProbeBase(BANK, `${GW}/token`)).toBe(GW)
  })

  it('token URL is cut back to the origin, path and query dropped', () => {
    expect(gatewayProbeBase(null, `${GW}/oauth2/token?x=1`)).toBe(GW)
  })

  it('both internal → API base wins (stable pick; same gateway either way)', () => {
    expect(gatewayProbeBase(GW, 'http://other-gw:1080/token')).toBe(GW)
  })

  // `normalizeBankApiBase` returns null for an address it rejects (public host over http, junk).
  // Null must read as «not through the gateway», never as a probe of `null/healthz`.
  it('nulls → not in use', () => {
    expect(gatewayProbeBase(null, null)).toBeNull()
  })
})
