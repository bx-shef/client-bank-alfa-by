import { describe, expect, it, vi } from 'vitest'
import type { PortalRestDeps } from '../server/utils/portalRest'
import type { PortalToken } from '../server/utils/tokenStore'
import { createCachingResolver, createPortalRestResolver } from '../server/utils/portalRestResolver'
import type { RestCall } from '../server/utils/companyLookup'

function tok(memberId: string, expiresAt: number): PortalToken {
  return { memberId, domain: `${memberId}.bitrix24.by`, accessToken: `at-${expiresAt}`, refreshToken: 'rt', expiresAt, applicationToken: '' }
}

/** Build fake deps + spies. `expiresAt` is what ensureFresh reports for the bound token. */
function fakeDeps(over: Partial<PortalRestDeps> & { expiresAt?: number } = {}) {
  const loadToken = vi.fn(async (m: string) => tok(m, over.expiresAt ?? 1_000_000))
  const ensureFresh = vi.fn(async (t: PortalToken) => t)
  const callRest = vi.fn(async (host: string, at: string, method: string, params?: Record<string, unknown>) => ({ host, at, method, params }))
  const deps: PortalRestDeps = { loadToken, ensureFresh, callRest, ...over }
  return { deps, loadToken, ensureFresh, callRest }
}

describe('createPortalRestResolver (#191 bind-once)', () => {
  it('binds once and reuses the same RestCall across resolves within the token lifetime', async () => {
    const { deps, loadToken, ensureFresh } = fakeDeps({ expiresAt: 1_000_000 })
    const now = 500_000
    const resolve = createPortalRestResolver(deps, () => now)
    const c1 = await resolve('m1')
    const c2 = await resolve('m1')
    const c3 = await resolve('m1')
    expect(c1).toBe(c2)
    expect(c2).toBe(c3)
    expect(loadToken).toHaveBeenCalledTimes(1) // one token load for the whole burst
    expect(ensureFresh).toHaveBeenCalledTimes(1)
  })

  it('re-binds once the token is within the skew of expiry', async () => {
    const { deps, loadToken } = fakeDeps({ expiresAt: 1_000_000 })
    let now = 500_000
    const resolve = createPortalRestResolver(deps, () => now, 60_000)
    await resolve('m1')
    now = 1_000_000 - 60_000 // exactly at the skew boundary → stale → re-bind
    await resolve('m1')
    expect(loadToken).toHaveBeenCalledTimes(2)
  })

  it('re-bind uses the FRESH token, not the stale cached closure', async () => {
    // First load → token expiring at 1_000_000; second load → a DIFFERENT token expiring
    // later (rotated). After crossing the skew, the re-bound call must carry the NEW token.
    const loadToken = vi.fn()
      .mockResolvedValueOnce(tok('m1', 1_000_000)) // at-1000000
      .mockResolvedValueOnce(tok('m1', 2_000_000)) // at-2000000 (rotated)
    const callRest = vi.fn(async () => ({}))
    const deps: PortalRestDeps = { loadToken: loadToken as unknown as PortalRestDeps['loadToken'], ensureFresh: async t => t, callRest }
    let now = 500_000
    const resolve = createPortalRestResolver(deps, () => now, 60_000)
    const c1 = await resolve('m1')
    await c1!('crm.item.list', {})
    expect(callRest).toHaveBeenLastCalledWith('m1.bitrix24.by', 'at-1000000', 'crm.item.list', {})
    now = 940_000 // ≥ expiresAt − skew → re-bind
    const c2 = await resolve('m1')
    await c2!('crm.item.list', {})
    expect(c2).not.toBe(c1) // a new closure…
    expect(callRest).toHaveBeenLastCalledWith('m1.bitrix24.by', 'at-2000000', 'crm.item.list', {}) // …with the fresh token
  })

  it('evict drops a portal so the next resolve re-loads (uninstall cutoff)', async () => {
    const { deps, loadToken } = fakeDeps({ expiresAt: 1_000_000 })
    const resolve = createPortalRestResolver(deps, () => 0)
    await resolve('m1')
    await resolve('m1')
    expect(loadToken).toHaveBeenCalledTimes(1) // cached
    resolve.evict('m1')
    await resolve('m1')
    expect(loadToken).toHaveBeenCalledTimes(2) // re-loaded after evict
  })

  it('keeps reusing right up to (but not into) the skew window', async () => {
    const { deps, loadToken } = fakeDeps({ expiresAt: 1_000_000 })
    let now = 500_000
    const resolve = createPortalRestResolver(deps, () => now, 60_000)
    await resolve('m1')
    now = 1_000_000 - 60_000 - 1 // one ms before the skew boundary → still fresh
    await resolve('m1')
    expect(loadToken).toHaveBeenCalledTimes(1)
  })

  it('returns null for a portal with no token and does NOT cache it (re-resolves later)', async () => {
    const loadToken = vi.fn()
      .mockResolvedValueOnce(null) // first: not installed yet
      .mockResolvedValueOnce(tok('m1', 1_000_000)) // later: installed
    const { deps } = fakeDeps()
    deps.loadToken = loadToken as unknown as PortalRestDeps['loadToken']
    const now = 100
    const resolve = createPortalRestResolver(deps, () => now)
    expect(await resolve('m1')).toBeNull()
    const call = await resolve('m1')
    expect(call).not.toBeNull()
    expect(loadToken).toHaveBeenCalledTimes(2) // null was never cached
  })

  it('caches members independently', async () => {
    const { deps, loadToken } = fakeDeps({ expiresAt: 1_000_000 })
    const resolve = createPortalRestResolver(deps, () => 0)
    const a = await resolve('m1')
    const b = await resolve('m2')
    expect(a).not.toBe(b)
    expect(loadToken).toHaveBeenCalledTimes(2)
    expect(await resolve('m1')).toBe(a) // m1 still cached
    expect(loadToken).toHaveBeenCalledTimes(2)
  })

  it('the bound RestCall injects the portal host + fresh access token', async () => {
    const { deps, callRest } = fakeDeps({ expiresAt: 1_000_000 })
    const resolve = createPortalRestResolver(deps, () => 0)
    const call = await resolve('m1')
    await call!('crm.item.list', { a: 1 })
    expect(callRest).toHaveBeenCalledWith('m1.bitrix24.by', 'at-1000000', 'crm.item.list', { a: 1 })
  })
})

describe('createCachingResolver (#191 SDK transport — cache-forever + evict)', () => {
  const stubCall = (tag: string): RestCall => (async () => ({ tag })) as unknown as RestCall

  it('binds once per member and reuses the cached call (no expiry re-bind)', async () => {
    const bind = vi.fn(async (m: string) => stubCall(m))
    const resolve = createCachingResolver(bind)
    const a = await resolve('m1')
    const b = await resolve('m1')
    expect(a).toBe(b)
    expect(bind).toHaveBeenCalledTimes(1)
  })

  it('does not cache a null (no token) — re-resolves later', async () => {
    const bind = vi.fn<(m: string) => Promise<RestCall | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stubCall('m1'))
    const resolve = createCachingResolver(bind)
    expect(await resolve('m1')).toBeNull()
    expect(await resolve('m1')).not.toBeNull()
    expect(bind).toHaveBeenCalledTimes(2)
  })

  it('caches members independently and evict drops one portal', async () => {
    const bind = vi.fn(async (m: string) => stubCall(m))
    const resolve = createCachingResolver(bind)
    const a = await resolve('m1')
    await resolve('m2')
    expect(bind).toHaveBeenCalledTimes(2)
    expect(await resolve('m1')).toBe(a) // cached
    resolve.evict('m1')
    await resolve('m1')
    expect(bind).toHaveBeenCalledTimes(3) // re-bound after evict; m2 untouched
  })
})
