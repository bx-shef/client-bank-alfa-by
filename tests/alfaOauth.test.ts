import { describe, expect, it } from 'vitest'
import {
  ALFA_REFRESH_TOKEN_TTL_SEC,
  buildAuthorizeUrl,
  buildRefreshBody,
  buildTokenExchangeBody,
  isAccessTokenExpired,
  parseOAuthCallback,
  parseTokenResponse
} from '~/utils/alfaOauth'

const config = {
  baseUrl: 'https://developerhub.alfabank.by:8273/',
  clientId: 'CID',
  redirectUri: 'https://bank-import.bx-shef.by/oauth-alfabank-by/'
}

describe('buildAuthorizeUrl', () => {
  it('builds the /authorize URL with code flow params and trims trailing slash', () => {
    const url = new URL(buildAuthorizeUrl(config, 'st8'))
    expect(url.origin + url.pathname).toBe('https://developerhub.alfabank.by:8273/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('CID')
    expect(url.searchParams.get('scope')).toBe('accounts')
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri)
    expect(url.searchParams.get('state')).toBe('st8')
  })
  it('uses a custom scope when provided', () => {
    const url = new URL(buildAuthorizeUrl({ ...config, scope: 'accounts profile' }, 's'))
    expect(url.searchParams.get('scope')).toBe('accounts profile')
  })
  it('throws on empty baseUrl (would yield a relative URL)', () => {
    expect(() => buildAuthorizeUrl({ ...config, baseUrl: '' }, 's')).toThrow(/baseUrl is required/)
  })
})

describe('parseOAuthCallback', () => {
  it('returns the code when state matches', () => {
    expect(parseOAuthCallback({ code: 'abc', state: 's1' }, 's1')).toEqual({ code: 'abc' })
  })
  it('handles array-valued query params (Nuxt useRoute().query)', () => {
    expect(parseOAuthCallback({ code: ['abc'], state: ['s1'] }, 's1')).toEqual({ code: 'abc' })
  })
  it('throws when state is absent', () => {
    expect(() => parseOAuthCallback({ code: 'abc' }, 's1')).toThrow(/state mismatch/i)
  })
  it('includes error_description in the thrown message', () => {
    expect(() => parseOAuthCallback({ error: 'access_denied', error_description: 'user said no', state: 's1' }, 's1'))
      .toThrow(/access_denied — user said no/)
  })
  it('throws on state mismatch (CSRF guard)', () => {
    expect(() => parseOAuthCallback({ code: 'abc', state: 'x' }, 's1')).toThrow(/state mismatch/i)
  })
  it('throws on missing code', () => {
    expect(() => parseOAuthCallback({ state: 's1' }, 's1')).toThrow(/missing authorization code/i)
  })
  it('throws on an error callback', () => {
    expect(() => parseOAuthCallback({ error: 'access_denied', state: 's1' }, 's1')).toThrow(/access_denied/)
  })
})

describe('token request bodies', () => {
  it('builds the authorization_code exchange body', () => {
    const body = buildTokenExchangeBody(config, 'CODE', 'SECRET')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('CODE')
    expect(body.get('redirect_uri')).toBe(config.redirectUri)
    expect(body.get('client_id')).toBe('CID')
    expect(body.get('client_secret')).toBe('SECRET')
  })
  it('builds the refresh_token body', () => {
    const body = buildRefreshBody(config, 'RT', 'SECRET')
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT')
    expect(body.get('client_id')).toBe('CID')
    expect(body.get('client_secret')).toBe('SECRET')
    // refresh body must NOT carry redirect_uri (per RFC 6749 §6)
    expect(body.has('redirect_uri')).toBe(false)
  })
})

describe('parseTokenResponse', () => {
  it('normalizes a successful token payload', () => {
    const t = parseTokenResponse({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600 })
    expect(t).toEqual({ accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresIn: 3600 })
  })
  it('defaults token_type and expires_in', () => {
    expect(parseTokenResponse({ access_token: 'a', refresh_token: 'r' }))
      .toMatchObject({ tokenType: 'Bearer', expiresIn: 3600 })
  })
  it('throws on an error payload', () => {
    expect(() => parseTokenResponse({ error: 'invalid_grant', error_description: 'bad code' }))
      .toThrow(/invalid_grant — bad code/)
  })
  it('throws when access_token is missing (refresh present)', () => {
    expect(() => parseTokenResponse({ refresh_token: 'r' })).toThrow(/missing access_token\/refresh_token/)
  })
  it('throws when refresh_token is missing (access present)', () => {
    expect(() => parseTokenResponse({ access_token: 'a' })).toThrow(/missing access_token\/refresh_token/)
  })
})

describe('isAccessTokenExpired', () => {
  const issued = 1_000_000
  it('is false well within the lifetime', () => {
    expect(isAccessTokenExpired(issued, 3600, issued + 1000)).toBe(false)
  })
  it('is true within the skew window before expiry', () => {
    // expires at issued + 3_600_000; skew 60_000 → expired from issued + 3_540_000
    expect(isAccessTokenExpired(issued, 3600, issued + 3_540_000)).toBe(true)
  })
  it('is true exactly at the skew boundary (>=)', () => {
    expect(isAccessTokenExpired(issued, 3600, issued + 3_600_000 - 60_000)).toBe(true)
  })
  it('is false one ms before the skew boundary', () => {
    expect(isAccessTokenExpired(issued, 3600, issued + 3_600_000 - 60_000 - 1)).toBe(false)
  })
  it('with skew=0 is true exactly at expiry and after', () => {
    expect(isAccessTokenExpired(issued, 3600, issued + 3_600_000, 0)).toBe(true)
    expect(isAccessTokenExpired(issued, 3600, issued + 3_600_001, 0)).toBe(true)
  })
})

describe('ALFA_REFRESH_TOKEN_TTL_SEC', () => {
  it('matches the documented ~10h value', () => {
    expect(ALFA_REFRESH_TOKEN_TTL_SEC).toBe(36_000)
  })
})
