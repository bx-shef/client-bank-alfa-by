import { describe, expect, it, vi } from 'vitest'
import { B24OAuth } from '@bitrix24/b24jssdk'
import type { PortalToken } from '../server/utils/tokenStore'
import type { SdkPortalDeps } from '../server/utils/b24Sdk'
import { createPortalSdkResolver, SDK_CLIENT_TTL_MS } from '../server/utils/portalSdkResolver'

// The SDK constructor does only axios.create (no I/O), so mocking it is safe and lets us count
// how many B24OAuth clients the resolver builds (per-JOB memoisation vs per-resolution).
vi.mock('@bitrix24/b24jssdk', () => ({
  B24OAuth: vi.fn(function () {
    return {
      actions: { v2: {
        call: { make: async () => ({ isSuccess: true, getData: () => ({ result: { ok: true } }), getErrorMessages: () => [] }) },
        batch: { make: async (o: { calls: unknown[] }) => ({ isSuccess: true, getErrorMessages: () => [], getData: () => o.calls.map(() => ({ isSuccess: true, getData: () => ({ result: { b: true } }), getErrorMessages: () => [] })) }) }
      } },
      setCallbackRefreshAuth: () => {}, setRestrictionManagerParams: () => {}
    }
  }),
  // Used by disableSdkRetry (#123).
  ParamsFactory: { getDefault: () => ({ rateLimit: {}, operatingLimit: {}, adaptiveConfig: {} }) }
}))

const token = (over: Partial<PortalToken> = {}): PortalToken => ({
  memberId: 'M1', domain: 'acme.bitrix24.com', accessToken: 'AT', refreshToken: 'RT',
  expiresAt: 1_700_000_000_000, applicationToken: 'APPTOK', ...over
})

const deps = (over: Partial<SdkPortalDeps> = {}): SdkPortalDeps => ({
  loadToken: async () => token(),
  saveToken: async () => {},
  creds: { clientId: 'cid', clientSecret: 'sec' },
  now: () => 1_699_999_000_000,
  ...over
})

describe('createPortalSdkResolver (#191 SDK transport, per-JOB memoisation)', () => {
  it('resolves a working RestCall for a portal with a token', async () => {
    vi.mocked(B24OAuth).mockClear()
    const resolve = createPortalSdkResolver(deps())
    const call = await resolve('M1')
    expect(call).not.toBeNull()
    expect(await call!('crm.item.list', {})).toEqual({ result: { ok: true } })
  })

  it('memoises ONE client per portal within the TTL (a job\'s resolves share one bucket + one token load)', async () => {
    vi.mocked(B24OAuth).mockClear()
    const at = 1_000_000
    const loadToken = vi.fn(async () => token())
    const resolve = createPortalSdkResolver(deps({ loadToken }), () => at) // clock frozen → all within TTL
    await resolve('M1')
    await resolve('M1')
    await resolve('M1')
    // One construction AND one token load for the whole burst — shared rate-limiter bucket,
    // instead of a fresh client (and its own bucket + token read) per op.
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(1)
    expect(loadToken).toHaveBeenCalledTimes(1)
  })

  it('a FAILED call evicts its client so the NEXT resolve rebuilds — even within the TTL (wedge recovery)', async () => {
    // The wedge fix: a worker-lifetime cache would re-hand a stale/wedged client to every
    // BullMQ retry until the TTL lapsed (retry budget can be < TTL). Evicting on the failed
    // call caps recovery to the next resolve, not the TTL.
    vi.mocked(B24OAuth).mockReset()
    let n = 0
    vi.mocked(B24OAuth).mockImplementation((function () {
      const first = ++n === 1
      return {
        actions: { v2: { call: { make: async () => {
          if (first) throw new Error('invalid_grant') // client #1 is wedged
          return { isSuccess: true, getData: () => ({ result: { ok: true } }), getErrorMessages: () => [] }
        } } } },
        setCallbackRefreshAuth: () => {}, setRestrictionManagerParams: () => {}
      }
    }) as unknown as typeof B24OAuth)
    const at = 1000
    const resolve = createPortalSdkResolver(deps(), () => at) // clock frozen → still within TTL
    const c1 = await resolve('M1')
    await expect(c1!('x', {})).rejects.toThrow('invalid_grant') // failing call evicts client #1
    const c2 = await resolve('M1') // within TTL, but #1 was evicted → REBUILD
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(2)
    expect(await c2!('x', {})).toEqual({ result: { ok: true } }) // fresh client works
  })

  it('a stale client\'s failure does NOT evict a newer client for the same portal (guarded eviction)', async () => {
    vi.mocked(B24OAuth).mockReset()
    const fail = new Map<number, boolean>()
    let n = 0
    const clients: Array<{ id: number, make: () => Promise<unknown> }> = []
    vi.mocked(B24OAuth).mockImplementation((function () {
      const id = ++n
      const make = async () => {
        if (fail.get(id)) throw new Error('boom')
        return { isSuccess: true, getData: () => ({}), getErrorMessages: () => [] }
      }
      clients.push({ id, make })
      return { actions: { v2: { call: { make } } }, setCallbackRefreshAuth: () => {}, setRestrictionManagerParams: () => {} }
    }) as unknown as typeof B24OAuth)
    let at = 0
    const resolve = createPortalSdkResolver(deps(), () => at, 1000)
    const c1 = await resolve('M1') // client #1 cached
    at = 1000 // TTL lapsed → next resolve rebuilds
    const c2 = await resolve('M1') // client #2 cached (fresh)
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(2)
    // Now the OLD closure c1 fails — its client #1 is no longer the cached one, so eviction is
    // guarded and must NOT drop client #2.
    fail.set(1, true)
    await expect(c1!('x', {})).rejects.toThrow('boom')
    at = 1500 // still within #2's TTL (built at 1000, ttl 1000 → valid until 2000)
    const c3 = await resolve('M1')
    expect(c3).toBe(c2) // #2 survived the stale failure → no rebuild
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(2)
  })

  it('rebuilds after the TTL lapses, re-reading the CURRENT token (bounded wedge)', async () => {
    vi.mocked(B24OAuth).mockReset()
    const constructedWith: string[] = []
    vi.mocked(B24OAuth).mockImplementation((function (params: { accessToken: string }) {
      constructedWith.push(params.accessToken)
      return { actions: { v2: { call: { make: async () => ({ isSuccess: true, getData: () => ({}), getErrorMessages: () => [] }) } } }, setCallbackRefreshAuth: () => {}, setRestrictionManagerParams: () => {} }
    }) as unknown as typeof B24OAuth)
    let at = 1_000_000
    let current = token({ accessToken: 'AT1' })
    const resolve = createPortalSdkResolver(deps({ loadToken: async () => current }), () => at)
    await resolve('M1')
    await resolve('M1') // still within TTL → same client, no rebuild
    expect(constructedWith).toEqual(['AT1'])
    at += SDK_CLIENT_TTL_MS // TTL lapsed
    current = token({ accessToken: 'AT2' }) // rotated by a peer / keep-alive meanwhile
    await resolve('M1')
    expect(constructedWith).toEqual(['AT1', 'AT2']) // rebuild carries the rotated token
  })

  it('is inclusive at the TTL boundary: reuse strictly BEFORE ttl, rebuild AT/after it', async () => {
    vi.mocked(B24OAuth).mockClear()
    let at = 0
    const resolve = createPortalSdkResolver(deps(), () => at, 1000)
    await resolve('M1')
    at = 999 // < ttl → reuse
    await resolve('M1')
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(1)
    at = 1000 // == ttl → stale → rebuild
    await resolve('M1')
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(2)
  })

  it('returns null for a portal with no token (uninstalled / demo), never caches the null', async () => {
    const loadToken = vi.fn()
      .mockResolvedValueOnce(null) // not installed yet
      .mockResolvedValueOnce(token()) // later: installed
    vi.mocked(B24OAuth).mockClear()
    const resolve = createPortalSdkResolver(deps({ loadToken: loadToken as unknown as SdkPortalDeps['loadToken'] }), () => 0)
    expect(await resolve('ZZZ')).toBeNull()
    expect(vi.mocked(B24OAuth)).not.toHaveBeenCalled() // no client for a null token
    expect(await resolve('ZZZ')).not.toBeNull() // null was NOT cached → re-resolves
    expect(loadToken).toHaveBeenCalledTimes(2)
  })

  it('evict drops the cached client so the next resolve rebuilds (uninstall cutover)', async () => {
    vi.mocked(B24OAuth).mockClear()
    const resolve = createPortalSdkResolver(deps(), () => 0)
    await resolve('M1')
    await resolve('M1')
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(1) // memoised
    resolve.evict('M1')
    await resolve('M1')
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(2) // rebuilt after evict
  })

  it('batch() shares the SAME memoised client as call() — one construction serves both (#191)', async () => {
    // Explicit impl (with batch) — earlier tests may have left a batch-less mockImplementation.
    vi.mocked(B24OAuth).mockReset()
    vi.mocked(B24OAuth).mockImplementation((function () {
      return {
        actions: { v2: {
          call: { make: async () => ({ isSuccess: true, getData: () => ({ result: { ok: true } }), getErrorMessages: () => [] }) },
          batch: { make: async (o: { calls: unknown[] }) => ({ isSuccess: true, getErrorMessages: () => [], getData: () => o.calls.map(() => ({ isSuccess: true, getData: () => ({ result: { b: true } }), getErrorMessages: () => [] })) }) }
        } },
        setCallbackRefreshAuth: () => {}, setRestrictionManagerParams: () => {}
      }
    }) as unknown as typeof B24OAuth)
    const at = 1_000_000
    const resolve = createPortalSdkResolver(deps(), () => at)
    const call = await resolve('M1')
    const batch = await resolve.batch('M1')
    expect(batch).not.toBeNull()
    expect(await batch!([{ method: 'crm.status.list', params: {} }, { method: 'crm.status.list', params: {} }]))
      .toEqual([{ result: { b: true } }, { result: { b: true } }]) // per-command envelopes, in order
    expect(await call!('crm.item.list', {})).toEqual({ result: { ok: true } })
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(1) // call + batch = ONE client
  })

  it('batch() returns null for a portal with no token', async () => {
    const loadToken = vi.fn().mockResolvedValue(null)
    const resolve = createPortalSdkResolver(deps({ loadToken: loadToken as unknown as SdkPortalDeps['loadToken'] }), () => 0)
    expect(await resolve.batch('ZZZ')).toBeNull()
  })

  it('a FAILED batch evicts the shared client so the next resolve rebuilds (wedge recovery)', async () => {
    vi.mocked(B24OAuth).mockReset()
    let n = 0
    vi.mocked(B24OAuth).mockImplementation((function () {
      const first = ++n === 1
      return {
        actions: { v2: {
          call: { make: async () => ({ isSuccess: true, getData: () => ({ result: { ok: true } }), getErrorMessages: () => [] }) },
          batch: { make: async () => {
            if (first) throw new Error('invalid_grant') // client #1 wedged on batch
            return { isSuccess: true, getErrorMessages: () => [], getData: () => [] }
          } }
        } },
        setCallbackRefreshAuth: () => {}, setRestrictionManagerParams: () => {}
      }
    }) as unknown as typeof B24OAuth)
    const at = 1000
    const resolve = createPortalSdkResolver(deps(), () => at) // clock frozen → within TTL
    const b1 = await resolve.batch('M1')
    await expect(b1!([{ method: 'x' }])).rejects.toThrow('invalid_grant') // evicts client #1
    const b2 = await resolve.batch('M1') // within TTL, but #1 evicted → REBUILD
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(2)
    expect(await b2!([{ method: 'x' }])).toEqual([]) // fresh client works
  })

  it('caches members independently', async () => {
    vi.mocked(B24OAuth).mockClear()
    const resolve = createPortalSdkResolver(deps({ loadToken: async (m: string) => token({ memberId: m }) }), () => 0)
    await resolve('m1')
    await resolve('m2')
    await resolve('m1') // m1 still cached
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(2) // one per member, m1 reused
  })
})
