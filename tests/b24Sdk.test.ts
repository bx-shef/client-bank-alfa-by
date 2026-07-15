import { describe, expect, it, vi } from 'vitest'
import { B24OAuth } from '@bitrix24/b24jssdk'
import type { OAuthCallClient, SdkAjaxResult, SdkPortalDeps } from '../server/utils/b24Sdk'
import {
  buildRefreshPersist,
  makePortalSdkCall,
  makeSdkRestCall,
  oauthParamsFromToken,
  sdkPortalDeps,
  tokenFromOAuthParams
} from '../server/utils/b24Sdk'
import type { PortalToken, QueryFn } from '../server/utils/tokenStore'
import { decryptSecret, encryptSecret } from '../server/utils/secretCrypto'

// Adapter over @bitrix24/b24jssdk B24OAuth (#191). The pure mapping helpers and the REST
// wrapper (`makeSdkRestCall`, structural client) are tested with a fake — no live portal.
// `makePortalSdkCall` constructs the real `B24OAuth`; to cover its construct→wire path
// without a live portal we mock the SDK module (the constructor does no I/O — only
// axios.create — so this is safe). The PortalToken→B24OAuthParams mapping is additionally
// typecheck-verified against the real SDK types by `typecheck:server`.

// Self-contained factory (hoisted above imports) — no outer references allowed. Individual
// tests override via `vi.mocked(B24OAuth).mockImplementation(...)` to capture wiring.
vi.mock('@bitrix24/b24jssdk', () => ({
  // Regular function (not arrow) so `new B24OAuth(...)` is constructable.
  B24OAuth: vi.fn(function () {
    return {
      actions: { v2: { call: { make: async () => ({ isSuccess: true, getData: () => ({ result: { items: [] } }), getErrorMessages: () => [] }) } } },
      setCallbackRefreshAuth: () => {}
    }
  })
}))

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

describe('sdkPortalDeps (live token-store wiring)', () => {
  it('loadToken reads via getToken; saveToken persists with eventTs=0 (tombstone-guarded)', async () => {
    process.env.B24_TOKEN_ENC_KEY = 'bb'.repeat(32)
    const sql: Array<{ q: string, p?: unknown[] }> = []
    // Fake pg: tombstone SELECT → empty (not blocked); getToken SELECT → one row; upsert/delete → [].
    const query: QueryFn = async (q, p) => {
      sql.push({ q, p })
      if (/FROM portal_tokens WHERE member_id/i.test(q) && /SELECT member_id, domain/i.test(q)) {
        return [{ member_id: 'M1', domain: 'acme.bitrix24.com', access_token: 'AT', refresh_token_enc: encryptSecret('RT'), expires_at: 1_700_000_000_000, application_token: 'APPTOK' }]
      }
      return []
    }
    const deps = sdkPortalDeps({ query, clientId: 'cid', clientSecret: 'sec', now: () => 123 })
    expect(deps.creds).toEqual({ clientId: 'cid', clientSecret: 'sec' })

    const loaded = await deps.loadToken('M1')
    expect(loaded).toMatchObject({ memberId: 'M1', domain: 'acme.bitrix24.com', accessToken: 'AT' })
    // The refresh token is stored ENCRYPTED at rest — getToken must decrypt it back so the SDK
    // gets a usable refresh token (a silent decrypt bug would otherwise pass unnoticed).
    expect(loaded!.refreshToken).toBe('RT')

    await deps.saveToken(token({ accessToken: 'NEW', refreshToken: 'NEW_RT' }))
    // The tombstone guard ran with eventTs=0 → any tombstone (deleted_ts >= 0) would block a
    // resurrect; here none exists so the upsert proceeds. Prove eventTs=0 reached the store.
    const tomb = sql.find(s => /portal_tombstone WHERE member_id = \$1 AND deleted_ts >= \$2/i.test(s.q))
    expect(tomb?.p?.[1]).toBe(0)
    // The persist runs the real upsert; the refresh-token bind must be ENCRYPTED (not the
    // plaintext) and decrypt back to the token — proves the SDK-refresh → encrypted-persist
    // chain end-to-end, not just "an INSERT ran".
    const insert = sql.find(s => /INSERT INTO portal_tokens/i.test(s.q))
    expect(insert).toBeTruthy()
    const refreshEncBind = insert!.p?.[3] as string
    expect(refreshEncBind).not.toBe('NEW_RT') // not stored in plaintext
    expect(decryptSecret(refreshEncBind)).toBe('NEW_RT') // encrypted, round-trips
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
    vi.mocked(B24OAuth).mockClear()
    expect(await makePortalSdkCall('M1', deps({ loadToken: async () => null }))).toBeNull()
    expect(vi.mocked(B24OAuth)).not.toHaveBeenCalled()
  })

  it('constructs one B24OAuth with mapped params + creds, wires refresh-persist, returns a working RestCall', async () => {
    const saved: PortalToken[] = []
    const calls: Array<{ method: string }> = []
    let registeredCb: ((a: { authData: never, b24OAuthParams: ReturnType<typeof oauthParamsFromToken> }) => Promise<void>) | null = null
    vi.mocked(B24OAuth).mockReset()
    // Regular function (not arrow) so `new B24OAuth(...)` returns this object.
    vi.mocked(B24OAuth).mockImplementation((function () {
      return {
        actions: { v2: { call: { make: async (o: { method: string }) => {
          calls.push(o)
          return ajax()
        } } } },
        setCallbackRefreshAuth: (cb: typeof registeredCb) => {
          registeredCb = cb
        }
      }
    }) as unknown as typeof B24OAuth)

    const call = await makePortalSdkCall('M1', deps({ saveToken: async (t) => {
      saved.push(t)
    } }))

    // one instance per portal, constructed with the mapped params + our creds
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(1)
    const [params, secret] = vi.mocked(B24OAuth).mock.calls[0]
    expect(params).toMatchObject({ memberId: 'M1', accessToken: 'AT', clientEndpoint: 'https://acme.bitrix24.com/rest/' })
    expect(secret).toEqual({ clientId: 'local.x', clientSecret: 'SECRET' })

    // returns a working RestCall routed through the client
    const out = await call!('crm.item.list')
    expect(out).toEqual({ result: { items: [] } })
    expect(calls[0]).toMatchObject({ method: 'crm.item.list' })

    // refresh-persist wired: the registered callback saves the refreshed token to our store
    expect(registeredCb).toBeTypeOf('function')
    await registeredCb!({ authData: {} as never, b24OAuthParams: oauthParamsFromToken(token({ accessToken: 'REFRESHED' }), { nowMs: 0 }) })
    expect(saved[0]).toMatchObject({ accessToken: 'REFRESHED', memberId: 'M1' })
  })
})
