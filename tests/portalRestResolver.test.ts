import { describe, expect, it, vi } from 'vitest'
import type { PortalRestDeps } from '../server/utils/portalRest'
import type { PortalToken } from '../server/utils/tokenStore'
import { createPortalRestResolver } from '../server/utils/portalRestResolver'
import { B24RestError } from '../server/utils/b24Rest'

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

describe('createPortalRestResolver — reactive expired_token retry', () => {
  it('on expired_token: force-refreshes and retries ONCE with the fresh token', async () => {
    const rotated: PortalToken = { memberId: 'm1', domain: 'm1.bitrix24.by', accessToken: 'AT-NEW', refreshToken: 'rt', expiresAt: 2_000_000, applicationToken: '' }
    const loadToken = vi.fn(async () => tok('m1', 1_000_000)) // access token at-1000000
    const ensureFresh = vi.fn(async (t: PortalToken, opts?: { force?: boolean }) => (opts?.force ? rotated : t))
    // First call rejects with expired_token; the forced-refresh retry succeeds.
    const callRest = vi.fn()
      .mockRejectedValueOnce(new B24RestError('expired_token', 'expired', 'B24 REST … failed'))
      .mockResolvedValueOnce({ ok: true })
    const deps: PortalRestDeps = { loadToken, ensureFresh: ensureFresh as PortalRestDeps['ensureFresh'], callRest: callRest as unknown as PortalRestDeps['callRest'] }
    const resolve = createPortalRestResolver(deps, () => 0)
    const call = await resolve('m1')
    const out = await call!('crm.item.list', { a: 1 })
    expect(out).toEqual({ ok: true })
    expect(ensureFresh).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'at-1000000' }), { force: true })
    // retry used the ROTATED token/host
    expect(callRest).toHaveBeenLastCalledWith('m1.bitrix24.by', 'AT-NEW', 'crm.item.list', { a: 1 })
    expect(callRest).toHaveBeenCalledTimes(2)
  })

  it('updates the cache so the NEXT call uses the refreshed token (no second refresh)', async () => {
    const rotated: PortalToken = { memberId: 'm1', domain: 'm1.bitrix24.by', accessToken: 'AT-NEW', refreshToken: 'rt', expiresAt: 2_000_000, applicationToken: '' }
    const ensureFresh = vi.fn(async (t: PortalToken, opts?: { force?: boolean }) => (opts?.force ? rotated : t))
    const callRest = vi.fn()
      .mockRejectedValueOnce(new B24RestError('expired_token', '', 'x'))
      .mockResolvedValue({ ok: true })
    const deps: PortalRestDeps = { loadToken: async () => tok('m1', 1_000_000), ensureFresh: ensureFresh as PortalRestDeps['ensureFresh'], callRest: callRest as unknown as PortalRestDeps['callRest'] }
    const resolve = createPortalRestResolver(deps, () => 0)
    await (await resolve('m1'))!('x', {}) // trigger the retry and AWAIT it fully → cache updated
    await (await resolve('m1'))!('y', {})
    // one forced refresh total; the cached call now carries AT-NEW
    expect(ensureFresh.mock.calls.filter(c => c[1]?.force).length).toBe(1)
    expect(callRest).toHaveBeenLastCalledWith('m1.bitrix24.by', 'AT-NEW', 'y', {})
  })

  it('propagates a NON-expiry error without refreshing or retrying', async () => {
    const ensureFresh = vi.fn(async (t: PortalToken) => t)
    const callRest = vi.fn().mockRejectedValue(new B24RestError('QUERY_LIMIT_EXCEEDED', '', 'limit'))
    const deps: PortalRestDeps = { loadToken: async () => tok('m1', 1_000_000), ensureFresh: ensureFresh as PortalRestDeps['ensureFresh'], callRest: callRest as unknown as PortalRestDeps['callRest'] }
    const resolve = createPortalRestResolver(deps, () => 0)
    const call = await resolve('m1')
    await expect(call!('x', {})).rejects.toThrow(/limit/)
    expect(callRest).toHaveBeenCalledTimes(1) // no retry
    expect(ensureFresh.mock.calls.some(c => c[1]?.force)).toBe(false) // no force refresh
  })

  it('a SECOND consecutive expired_token throws (only one retry, no loop)', async () => {
    const ensureFresh = vi.fn(async (t: PortalToken) => ({ ...t, accessToken: 'AT-NEW' }))
    const callRest = vi.fn().mockRejectedValue(new B24RestError('expired_token', '', 'still expired'))
    const deps: PortalRestDeps = { loadToken: async () => tok('m1', 1_000_000), ensureFresh: ensureFresh as PortalRestDeps['ensureFresh'], callRest: callRest as unknown as PortalRestDeps['callRest'] }
    const resolve = createPortalRestResolver(deps, () => 0)
    const call = await resolve('m1')
    await expect(call!('x', {})).rejects.toThrow(/still expired/)
    expect(callRest).toHaveBeenCalledTimes(2) // original + one retry, then it throws
  })
})
