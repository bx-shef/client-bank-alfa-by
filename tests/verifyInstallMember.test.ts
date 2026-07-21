import { describe, expect, it, vi } from 'vitest'
import { rawOauthRefresh, verifyInstallMember, type OAuthFetchFn } from '../server/utils/verifyInstallMember'

/** A successful OAuth token-refresh JSON for `member`, with rotated tokens. */
function grantJson(member: string) {
  return {
    access_token: 'A2',
    refresh_token: 'R2',
    expires_in: 3600,
    member_id: member,
    client_endpoint: 'https://victim.bitrix24.by/rest/'
  }
}

describe('verifyInstallMember (#162)', () => {
  it('binds: authoritative member_id matches the claim → ok + ROTATED grant', async () => {
    const refresh = vi.fn(async () => grantJson('m1'))
    const r = await verifyInstallMember('m1', 'R', { refresh })
    expect(refresh).toHaveBeenCalledWith('R')
    expect(r).toEqual({
      ok: true,
      grant: { accessToken: 'A2', refreshToken: 'R2', clientEndpoint: 'https://victim.bitrix24.by/rest/', expiresIn: 3600 }
    })
  })

  it('matches member_id case-insensitively / trimmed', async () => {
    const r = await verifyInstallMember('  M1 ', 'R', { refresh: async () => grantJson('m1') })
    expect(r.ok).toBe(true)
  })

  it('REJECTS a spoofed member_id — grant belongs to another portal → 403 (poisoning defence)', async () => {
    // Attacker claims victim m1 but can only present THEIR OWN refresh_token → authoritative = attacker.
    const r = await verifyInstallMember('m1', 'attacker-refresh', { refresh: async () => grantJson('attacker') })
    expect(r).toEqual({ ok: false, status: 403 })
  })

  it('empty claim or empty refresh_token → 403 (nothing to bind, fail-closed)', async () => {
    const refresh = vi.fn(async () => grantJson('m1'))
    expect(await verifyInstallMember('', 'R', { refresh })).toEqual({ ok: false, status: 403 })
    expect(await verifyInstallMember('m1', '', { refresh })).toEqual({ ok: false, status: 403 })
    expect(refresh).not.toHaveBeenCalled() // no OAuth call when there's nothing to verify
  })

  it('forged grant (invalid_grant/invalid_token/expired_token) → 403', async () => {
    for (const code of ['invalid_grant', 'invalid_token', 'expired_token']) {
      const r = await verifyInstallMember('m1', 'R', { refresh: async () => ({ error: code }) })
      expect(r).toEqual({ ok: false, status: 403 })
    }
  })

  it('our-config / transient OAuth error (wrong_client) → 503 (fail-closed, retryable)', async () => {
    const r = await verifyInstallMember('m1', 'R', { refresh: async () => ({ error: 'wrong_client' }) })
    expect(r).toEqual({ ok: false, status: 503 })
  })

  it('network / transport failure → 503', async () => {
    const r = await verifyInstallMember('m1', 'R', {
      refresh: async () => { throw new Error('ECONNRESET') }
    })
    expect(r).toEqual({ ok: false, status: 503 })
  })

  it('malformed success (no access_token) → 503, not a crash', async () => {
    const r = await verifyInstallMember('m1', 'R', { refresh: async () => ({ member_id: 'm1' }) })
    expect(r).toEqual({ ok: false, status: 503 })
  })

  it('a JSON primitive body → 503 (no `in`-on-primitive crash — fail-closed holds)', async () => {
    const r = await verifyInstallMember('m1', 'R', { refresh: async () => 'unexpected' })
    expect(r).toEqual({ ok: false, status: 503 })
  })

  it('success without member_id echoed → 503 (cannot bind, do not false-accept)', async () => {
    const r = await verifyInstallMember('m1', 'R', {
      refresh: async () => ({ access_token: 'A2', refresh_token: 'R2', expires_in: 3600 })
    })
    expect(r).toEqual({ ok: false, status: 503 })
  })
})

describe('rawOauthRefresh transport', () => {
  it('POSTs the refresh body (creds in body, not URL) to the fixed OAuth host and returns parsed JSON', async () => {
    const fetchFn = vi.fn<OAuthFetchFn>(async () => ({ json: async () => ({ access_token: 'A2', member_id: 'm1' }) }))
    const refresh = rawOauthRefresh(fetchFn, { clientId: 'CID', clientSecret: 'CSECRET' })
    const out = await refresh('R')
    expect(out).toEqual({ access_token: 'A2', member_id: 'm1' })
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://oauth.bitrix.info/oauth/token/')
    expect(init.method).toBe('POST')
    // Secrets ride in the BODY (never the URL → no access-log leak).
    expect(url).not.toContain('CSECRET')
    expect(init.body).toContain('refresh_token=R')
    expect(init.body).toContain('client_secret=CSECRET')
    expect(init.body).toContain('grant_type=refresh_token')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
