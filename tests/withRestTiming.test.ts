import { afterEach, describe, expect, it, vi } from 'vitest'

// `withRestTiming` decides enabled/disabled ONCE (lazy-cached module state), so each case
// loads the module fresh with REST_TIMING stubbed to exercise both branches cleanly.
async function loadWithRestTiming(restTiming?: string) {
  vi.resetModules()
  vi.unstubAllEnvs()
  if (restTiming !== undefined) vi.stubEnv('REST_TIMING', restTiming)
  return (await import('../server/utils/b24Rest')).withRestTiming
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('withRestTiming (#78 — SDK-path timing wrapper)', () => {
  it('when OFF, returns the call UNWRAPPED (zero overhead, no log)', async () => {
    const withRestTiming = await loadWithRestTiming('0')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = (async () => ({ result: 1 })) as never
    expect(withRestTiming(call)).toBe(call) // same reference — not wrapped
    expect(spy).not.toHaveBeenCalled()
  })

  it('when ON, logs ok=1 with server time on success and passes the result through', async () => {
    const withRestTiming = await loadWithRestTiming('1')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const wrapped = withRestTiming(async () => ({ result: [], time: { duration: 0.012 } }))
    const out = await wrapped('crm.item.list', { a: 1 })
    expect(out).toEqual({ result: [], time: { duration: 0.012 } }) // result untouched
    expect(spy).toHaveBeenCalledTimes(1)
    // ms is wall-time (don't pin exact — a slow tick could make it >0); pin method/srv/ok.
    expect(spy.mock.calls[0]![0]).toMatch(/^\[rest-timing\] method=crm\.item\.list ms=\d+ srv=12 ok=1$/)
  })

  it('when ON, logs ok=0 and rethrows the same error on failure', async () => {
    const withRestTiming = await loadWithRestTiming('yes')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const boom = new Error('QUERY_LIMIT_EXCEEDED')
    const wrapped = withRestTiming(() => Promise.reject(boom))
    await expect(wrapped('user.current', {})).rejects.toBe(boom)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toMatch(/^\[rest-timing\] method=user\.current ms=\d+ ok=0$/)
  })
})
