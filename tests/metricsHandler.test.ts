import { describe, expect, it, vi } from 'vitest'
import { handleMetrics, handleMetricsReset, type MetricsDeps } from '../server/utils/metricsHandler'

function deps(over: Partial<MetricsDeps> = {}): MetricsDeps {
  return {
    memberIdByDomain: async () => 'm1',
    validateFrame: async () => 'user-7',
    readCounters: async () => ({ created: 5, allocated: 2 }),
    resetCounters: async () => {},
    ...over
  }
}
const input = { accessToken: 'tok', domain: 'p.bitrix24.by' }

describe('handleMetrics (auth ladder)', () => {
  it('401 when token or domain is missing', async () => {
    expect((await handleMetrics(deps(), { accessToken: '', domain: 'p' })).status).toBe(401)
    expect((await handleMetrics(deps(), { accessToken: 't', domain: '' })).status).toBe(401)
  })

  it('409 when the app is not installed for the domain', async () => {
    const r = await handleMetrics(deps({ memberIdByDomain: async () => null }), input)
    expect(r.status).toBe(409)
  })

  it('403 when the frame token is invalid / foreign (throws or empty user)', async () => {
    const throwing = () => Promise.reject(new Error('bad'))
    expect((await handleMetrics(deps({ validateFrame: throwing }), input)).status).toBe(403)
    expect((await handleMetrics(deps({ validateFrame: async () => '' }), input)).status).toBe(403)
  })

  it('200 with the portal counters on success', async () => {
    const r = await handleMetrics(deps(), input)
    expect(r).toEqual({ status: 200, body: { counters: { created: 5, allocated: 2 } } })
  })

  it('reads counters for the resolved member_id', async () => {
    const readCounters = vi.fn(async () => ({ created: 1 }))
    await handleMetrics(deps({ memberIdByDomain: async () => 'mX', readCounters }), input)
    expect(readCounters).toHaveBeenCalledWith('mX')
  })
})

describe('handleMetricsReset', () => {
  it('resets the resolved portal and returns an empty map', async () => {
    const resetCounters = vi.fn(async () => {})
    const r = await handleMetricsReset(deps({ memberIdByDomain: async () => 'mX', resetCounters }), input)
    expect(resetCounters).toHaveBeenCalledWith('mX')
    expect(r).toEqual({ status: 200, body: { counters: {} } })
  })

  it('enforces the same auth ladder (403 on a foreign token, no reset)', async () => {
    const resetCounters = vi.fn(async () => {})
    const r = await handleMetricsReset(deps({ validateFrame: async () => '', resetCounters }), input)
    expect(r.status).toBe(403)
    expect(resetCounters).not.toHaveBeenCalled()
  })

  it('does not reset on a 401 (missing token) or 409 (not installed)', async () => {
    const resetCounters = vi.fn(async () => {})
    const r401 = await handleMetricsReset(deps({ resetCounters }), { accessToken: '', domain: '' })
    expect(r401.status).toBe(401)
    const r409 = await handleMetricsReset(deps({ memberIdByDomain: async () => null, resetCounters }), input)
    expect(r409.status).toBe(409)
    expect(resetCounters).not.toHaveBeenCalled()
  })
})
