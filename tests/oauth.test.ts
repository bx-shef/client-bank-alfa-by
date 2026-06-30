import { describe, it, expect } from 'vitest'
import {
  buildAuthorizeUrl,
  buildAuthorizationCodeBody,
  buildRefreshTokenBody,
  basicAuthHeader,
  parseAuthorizationCallback
} from '~/utils/oauth'
import { ALFA_OAUTH_ENDPOINTS, ALFA_STATEMENT_SCOPES } from '~/config/alfa'

describe('buildAuthorizeUrl', () => {
  it('builds a code-grant authorize URL with all required params', () => {
    const url = buildAuthorizeUrl(ALFA_OAUTH_ENDPOINTS, {
      clientId: 'abc',
      redirectUri: 'https://app.example.com/cb',
      scopes: ALFA_STATEMENT_SCOPES,
      state: 's1'
    })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://developerhub.alfabank.by:8273/authorize')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('client_id')).toBe('abc')
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb')
    expect(u.searchParams.get('scope')).toBe('accounts read_documents profile')
    expect(u.searchParams.get('state')).toBe('s1')
  })

  it('accepts a pre-joined scope string', () => {
    const url = buildAuthorizeUrl(ALFA_OAUTH_ENDPOINTS, {
      clientId: 'abc',
      redirectUri: 'https://x',
      scopes: 'accounts profile',
      state: 's'
    })
    expect(new URL(url).searchParams.get('scope')).toBe('accounts profile')
  })
})

describe('token request bodies', () => {
  it('builds the authorization_code exchange body', () => {
    const body = buildAuthorizationCodeBody({ code: 'C0DE', redirectUri: 'https://x/cb' })
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('C0DE')
    expect(body.get('redirect_uri')).toBe('https://x/cb')
  })

  it('builds the refresh_token body', () => {
    const body = buildRefreshTokenBody('R3FRESH')
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('R3FRESH')
  })
})

describe('basicAuthHeader', () => {
  it('base64-encodes client_id:client_secret', () => {
    expect(basicAuthHeader('id', 'secret')).toBe('Basic ' + Buffer.from('id:secret').toString('base64'))
  })
})

describe('parseAuthorizationCallback', () => {
  it('extracts code and state from a full redirect URL', () => {
    const cb = parseAuthorizationCallback('https://app.example.com/cb?code=AUTH123&state=s1')
    expect(cb.code).toBe('AUTH123')
    expect(cb.state).toBe('s1')
    expect(cb.error).toBeUndefined()
  })

  it('parses a bare query string', () => {
    const cb = parseAuthorizationCallback('?code=XYZ&state=s2')
    expect(cb.code).toBe('XYZ')
    expect(cb.state).toBe('s2')
  })

  it('surfaces the OAuth error path', () => {
    const cb = parseAuthorizationCallback('https://x/cb?error=access_denied&error_description=User%20denied')
    expect(cb.error).toBe('access_denied')
    expect(cb.errorDescription).toBe('User denied')
    expect(cb.code).toBeUndefined()
  })
})
