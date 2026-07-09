import { describe, expect, it } from 'vitest'
import type { PortalToken } from '../server/utils/tokenStore'
import type { OAuthCallClient, SdkAjaxResult, SdkPortalDeps } from '../server/utils/b24Sdk'
import {
  buildRefreshPersist,
  makePortalSdkCall,
  makeSdkRestCall,
  oauthParamsFromToken,
  tokenFromOAuthParams
} from '../server/utils/b24Sdk'

// Adapter over @bitrix24/b24jssdk B24OAuth (#191). The pure mapping helpers and the REST
// wrapper (`makeSdkRestCall`, which takes a STRUCTURAL client) are tested with a fake — no
// live portal. `makePortalSdkCall` constructs the real `B24OAuth`, so only its
// no-token early-return (before any SDK construction) is unit-tested here; the live
// construct→call path is exercised by `pnpm sdk:test` before the crm-sync swap. The
// PortalToken→B24OAuthParams mapping is additionally typecheck-verified against the real
// SDK types by `typecheck:server`.

const token = (over: Partial<PortalToken> = {}): PortalToken => ({
  memberId: 'M1', domain: 'acme.bitrix24.com', accessToken: 'AT', refreshToken: 'RT',
  expiresAt: 1_700_000_000_000, applicationToken: 'APPTOK', ...over
})

/** A fake AjaxResult. */
const ajax = (over: Partial<SdkAjaxResult> = {}): SdkAjaxResult => ({
  isSuccess: true, getData: () => ({ result: { items: [] } }), getErrorMessages: () => [], ...over
})

/** A fake OAuth client recording calls made through it. */
function fakeClient(res: SdkAjaxResult = ajax()) {
  const calls: Array<{ method: string, params?: Record<string, unknown> }> = []
  const client: OAuthCallClient = {
    actions: { v2: { call: { make: async (o) => {
      calls.push(o)
      return res
    } } } },
    setCallbackRefreshAuth: () => {}
  }
  return { client, calls }
}

describe('oauthParamsFromToken', () => {
  it('maps our PortalToken to B24OAuthParams (seconds, endpoints, defaults)', () => {
    const p = oauthParamsFromToken(token(), { nowMs: 1_699_999_000_000, scope: 'crm,im' })
    expect(p.memberId).toBe('M1')
    expect(p.accessToken).toBe('AT')
    expect(p.refreshToken).toBe('RT')
    expect(p.applicationToken).toBe('APPTOK')
    expect(p.expires).toBe(1_700_000_000) // ms → s
    expect(p.expiresIn).toBe(1000) // (expiresAt - nowMs)/1000
    expect(p.scope).toBe('crm,im')
    expect(p.domain).toBe('acme.bitrix24.com')
    expect(p.clientEndpoint).toBe('https://acme.bitrix24.com/rest/')
    expect(p.serverEndpoint).toBe('https://oauth.bitrix.info/rest/')
    expect(p.status).toBe('L')
    expect(p.userId).toBe(0)
  })

  it('clamps a past-expiry token to expiresIn 0 and defaults scope to empty', () => {
    const p = oauthParamsFromToken(token({ expiresAt: 1_000 }), { nowMs: 2_000 })
    expect(p.expiresIn).toBe(0)
    expect(p.scope).toBe('')
  })

  it('trims the domain (no stray whitespace leaks into domain or clientEndpoint URL)', () => {
    const p = oauthParamsFromToken(token({ domain: '  acme.bitrix24.com  ' }), { nowMs: 0 })
    expect(p.domain).toBe('acme.bitrix24.com')
    expect(p.clientEndpoint).toBe('https://acme.bitrix24.com/rest/')
  })
})

describe('tokenFromOAuthParams', () => {
  it('is the inverse of the mapping for the persisted fields (s → ms)', () => {
    const p = oauthParamsFromToken(token(), { nowMs: 1_699_999_000_000 })
    expect(tokenFromOAuthParams(p)).toEqual(token()) // expiresAt round-trips at second granularity
  })
})

describe('buildRefreshPersist', () => {
  it('persists the SDK-refreshed token to our store', async () => {
    const saved: PortalToken[] = []
    const cb = buildRefreshPersist(async (t) => {
      saved.push(t)
    })
    const refreshed = oauthParamsFromToken(token({ accessToken: 'NEW_AT', refreshToken: 'NEW_RT' }), { nowMs: 0 })
    // The SDK invokes the callback with authData + b24OAuthParams; we only read the latter.
    await cb({ authData: {} as never, b24OAuthParams: refreshed })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ accessToken: 'NEW_AT', refreshToken: 'NEW_RT', memberId: 'M1', applicationToken: 'APPTOK' })
  })
})

describe('makeSdkRestCall', () => {
  it('unwraps the REST envelope on success', async () => {
    const { client, calls } = fakeClient(ajax({ getData: () => ({ result: { items: [{ id: 7 }] } }) }))
    const call = makeSdkRestCall(client)
    const out = await call('crm.item.list', { entityTypeId: 31 })
    expect(out).toEqual({ result: { items: [{ id: 7 }] } })
    expect(calls[0]).toEqual({ method: 'crm.item.list', params: { entityTypeId: 31 } })
  })

  it('returns {} when getData is null/undefined (tolerant)', async () => {
    const { client } = fakeClient(ajax({ getData: () => null }))
    expect(await makeSdkRestCall(client)('x')).toEqual({})
  })

  it('passes getData through verbatim — does NOT validate the envelope shape', async () => {
    // Documents the contract: the adapter is a thin transport, not a validator. Whatever
    // the SDK hands back (even without a `result` key) reaches the lookup unchanged.
    const { client } = fakeClient(ajax({ getData: () => ({ foo: 1 }) }))
    expect(await makeSdkRestCall(client)('x')).toEqual({ foo: 1 })
  })

  it('throws the SDK error messages on failure (so the job fails → clean retry)', async () => {
    const { client } = fakeClient(ajax({ isSuccess: false, getErrorMessages: () => ['QUERY_LIMIT_EXCEEDED', 'slow down'] }))
    await expect(makeSdkRestCall(client)('crm.item.list')).rejects.toThrow('QUERY_LIMIT_EXCEEDED; slow down')
  })

  it('throws a generic message when the SDK gives no error text', async () => {
    const { client } = fakeClient(ajax({ isSuccess: false, getErrorMessages: () => [] }))
    await expect(makeSdkRestCall(client)('crm.deal.get')).rejects.toThrow('B24 REST crm.deal.get failed')
  })
})

describe('makePortalSdkCall', () => {
  const deps = (over: Partial<SdkPortalDeps> = {}): SdkPortalDeps => ({
    loadToken: async () => token(),
    saveToken: async () => {},
    creds: { clientId: 'local.x', clientSecret: 'SECRET' },
    now: () => 1_699_999_000_000,
    ...over
  })

  it('returns null when the portal has no token (no client constructed)', async () => {
    // Same contract as makePortalRestCall — drop-in swap. Returns before touching the SDK.
    expect(await makePortalSdkCall('M1', deps({ loadToken: async () => null }))).toBeNull()
  })
})
