import { describe, expect, it } from 'vitest'
import { buildRefreshBody, hostFromEndpoint, parseRefreshResponse } from '../server/utils/b24Oauth'
import { needsRefresh } from '../server/utils/ensureAccessToken'
import type { PortalToken } from '../server/utils/tokenStore'

describe('buildRefreshBody', () => {
  it('builds a form-urlencoded refresh_token body with encoded params (creds not in a URL)', () => {
    const body = buildRefreshBody({ clientId: 'cid', clientSecret: 's/e+t' }, 'r t')
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('client_id=cid')
    expect(body).toContain('client_secret=s%2Fe%2Bt')
    expect(body).toContain('refresh_token=r+t')
    expect(body.startsWith('http')).toBe(false)
  })
})

describe('parseRefreshResponse', () => {
  it('maps snake_case fields', () => {
    const r = parseRefreshResponse({
      access_token: 'AT', refresh_token: 'RT', expires_in: 3600,
      member_id: 'M', client_endpoint: 'https://p.bitrix24.by/rest/'
    })
    expect(r).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, memberId: 'M', clientEndpoint: 'https://p.bitrix24.by/rest/' })
  })

  it('defaults expiresIn to 3600 when missing/invalid', () => {
    expect(parseRefreshResponse({ access_token: 'AT' }).expiresIn).toBe(3600)
    expect(parseRefreshResponse({ access_token: 'AT', expires_in: 0 }).expiresIn).toBe(3600)
  })

  it('throws on an error body (no access_token)', () => {
    expect(() => parseRefreshResponse({ error: 'invalid_grant' })).toThrow(/invalid_grant/)
    expect(() => parseRefreshResponse({})).toThrow()
  })
})

describe('hostFromEndpoint', () => {
  it('extracts the host', () => {
    expect(hostFromEndpoint('https://p.bitrix24.by/rest/')).toBe('p.bitrix24.by')
  })
  it('is undefined for missing/garbage', () => {
    expect(hostFromEndpoint(undefined)).toBeUndefined()
    expect(hostFromEndpoint('not a url')).toBeUndefined()
  })
})

describe('needsRefresh', () => {
  const base: PortalToken = { memberId: 'M', domain: 'p.bitrix24.by', accessToken: 'AT', refreshToken: 'RT', expiresAt: 0, applicationToken: 'x' }
  it('true when within the skew window / already expired', () => {
    expect(needsRefresh({ ...base, expiresAt: 1_000 }, 2_000)).toBe(true)
    expect(needsRefresh({ ...base, expiresAt: 100_000 }, 50_000, 60_000)).toBe(true) // 100k <= 50k+60k
  })
  it('false when comfortably valid', () => {
    expect(needsRefresh({ ...base, expiresAt: 1_000_000 }, 50_000, 60_000)).toBe(false)
  })
})
