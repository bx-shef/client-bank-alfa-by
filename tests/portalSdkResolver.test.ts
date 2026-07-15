import { describe, expect, it, vi } from 'vitest'
import { B24OAuth } from '@bitrix24/b24jssdk'
import type { PortalToken } from '../server/utils/tokenStore'
import type { SdkPortalDeps } from '../server/utils/b24Sdk'
import { createPortalSdkResolver } from '../server/utils/portalSdkResolver'

// The SDK constructor does only axios.create (no I/O), so mocking it is safe and lets us
// prove the resolver builds a FRESH B24OAuth per resolution (no process-lifetime cache).
vi.mock('@bitrix24/b24jssdk', () => ({
  B24OAuth: vi.fn(function () {
    return {
      actions: { v2: { call: { make: async () => ({ isSuccess: true, getData: () => ({ result: { ok: true } }), getErrorMessages: () => [] }) } } },
      setCallbackRefreshAuth: () => {}
    }
  })
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

describe('createPortalSdkResolver (#191 SDK transport)', () => {
  it('resolves a working RestCall for a portal with a token', async () => {
    vi.mocked(B24OAuth).mockClear()
    const resolve = createPortalSdkResolver(deps())
    const call = await resolve('M1')
    expect(call).not.toBeNull()
    expect(await call!('crm.item.list', {})).toEqual({ result: { ok: true } })
  })

  it('builds a FRESH client per resolution (NOT cached — avoids the stale-token wedge)', async () => {
    vi.mocked(B24OAuth).mockClear()
    const resolve = createPortalSdkResolver(deps())
    await resolve('M1')
    await resolve('M1')
    await resolve('M1')
    // Three resolves → three constructions. A process cache would build once; per-resolution
    // build is what lets a peer/keep-alive rotation be observed on the next resolve.
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(3)
  })

  it('re-reads the CURRENT token each resolution (a rotation is picked up next resolve)', async () => {
    // The anti-wedge property: because the client is rebuilt per resolve from a fresh
    // loadToken, a peer/keep-alive rotation of the access token is reflected on resolve #2.
    vi.mocked(B24OAuth).mockReset()
    const constructedWith: string[] = []
    vi.mocked(B24OAuth).mockImplementation((function (params: { accessToken: string }) {
      constructedWith.push(params.accessToken)
      return { actions: { v2: { call: { make: async () => ({ isSuccess: true, getData: () => ({}), getErrorMessages: () => [] }) } } }, setCallbackRefreshAuth: () => {} }
    }) as unknown as typeof B24OAuth)
    let current = token({ accessToken: 'AT1' })
    const resolve = createPortalSdkResolver(deps({ loadToken: async () => current }))
    await resolve('M1')
    current = token({ accessToken: 'AT2' }) // rotated by a peer / keep-alive between resolves
    await resolve('M1')
    expect(constructedWith).toEqual(['AT1', 'AT2']) // second client carries the rotated token
  })

  it('returns null for a portal with no token (uninstalled / demo) — no client built', async () => {
    vi.mocked(B24OAuth).mockClear()
    const resolve = createPortalSdkResolver(deps({ loadToken: async () => null }))
    expect(await resolve('ZZZ')).toBeNull()
    expect(vi.mocked(B24OAuth)).not.toHaveBeenCalled()
  })

  it('evict is a no-op (nothing cached) and does not break later resolves', async () => {
    const resolve = createPortalSdkResolver(deps())
    expect(() => resolve.evict('M1')).not.toThrow()
    expect(await resolve('M1')).not.toBeNull()
  })
})
