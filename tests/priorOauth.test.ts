import { describe, expect, it } from 'vitest'
import {
  PRIOR_API_PREFIXES,
  CONSENT_PERMISSIONS,
  buildBasicAuthHeader,
  buildClientCredentialsBody,
  buildCodeExchangeBody,
  buildPriorRefreshBody,
  buildRegistrationMetadata,
  buildConsentRequest,
  buildAuthorizeRequestClaims,
  buildPriorAuthorizeUrl,
  buildResourceRequestBody,
  isWindowWithinLimit,
  parsePriorTokenResponse,
  extractIntentId,
  extractResourceId,
  extractAccounts
} from '~/utils/priorOauth'

// Pure Open Banking (СПР) core — same builders/parsers the sandbox script and
// the backend engine share. No network, no crypto; signing/transport are the
// caller's. These pin the wire shapes we confirmed live (see docs/PRIOR_API.md).

describe('token/auth bodies', () => {
  it('Basic auth header base64-encodes id:secret and never bare-prints the secret', () => {
    const header = buildBasicAuthHeader('client-42', 's3cr3t')
    expect(header).toBe('Basic ' + Buffer.from('client-42:s3cr3t').toString('base64'))
    expect(header).not.toContain('s3cr3t')
  })

  it('client_credentials body carries grant_type + scope, no secret', () => {
    const body = buildClientCredentialsBody('accounts')
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('scope')).toBe('accounts')
    expect(body.toString()).not.toMatch(/secret/i)
  })

  it('code-exchange and refresh bodies are RFC-6749 shaped', () => {
    const ex = buildCodeExchangeBody('AUTHCODE', 'https://cb.example/ob')
    expect(ex.get('grant_type')).toBe('authorization_code')
    expect(ex.get('code')).toBe('AUTHCODE')
    expect(ex.get('redirect_uri')).toBe('https://cb.example/ob')

    const rf = buildPriorRefreshBody('RT')
    expect(rf.get('grant_type')).toBe('refresh_token')
    expect(rf.get('refresh_token')).toBe('RT')
  })
})

describe('DCR registration metadata', () => {
  it('token_endpoint_auth_method is an ARRAY and jwks is a STRING (the two 500-hiding shapes)', () => {
    const jwks = { keys: [{ kty: 'RSA', kid: 'k1' }] }
    const meta = buildRegistrationMetadata({ clientName: 'App', redirectUri: 'https://cb/ob', jwks })
    expect(Array.isArray(meta.token_endpoint_auth_method)).toBe(true)
    expect(typeof meta.jwks).toBe('string')
    expect(JSON.parse(meta.jwks as string)).toEqual(jwks)
    expect(meta.redirect_uris).toEqual(['https://cb/ob'])
    expect(meta.client_name).toBe('App')
  })

  it('omits jwks when none is provided', () => {
    const meta = buildRegistrationMetadata({ clientName: 'App', redirectUri: 'https://cb/ob' })
    expect('jwks' in meta).toBe(false)
  })
})

describe('consent request', () => {
  it('wraps in { data }, defaults permissions, keeps expirationDate distinct from the window', () => {
    const req = buildConsentRequest({ expirationDate: '2026-09-30', transactionFromDate: '2026-06-01', transactionToDate: '2026-06-30' })
    expect(req.data.permissions).toEqual(CONSENT_PERMISSIONS)
    expect(req.data.expirationDate).toBe('2026-09-30')
    expect(req.data.transactionFromDate).toBe('2026-06-01')
    expect(req.data.transactionToDate).toBe('2026-06-30')
  })

  it('omits window bounds when absent and honours custom permissions', () => {
    const req = buildConsentRequest({ expirationDate: '2026-09-30', permissions: ['ReadAccountsBasic'] })
    expect(req.data.permissions).toEqual(['ReadAccountsBasic'])
    expect('transactionFromDate' in req.data).toBe(false)
    expect('transactionToDate' in req.data).toBe(false)
  })
})

describe('authorize request claims + URL', () => {
  const claimsInput = {
    clientId: 'CID', redirectUri: 'https://cb/ob', intentId: 'INTENT-1',
    aud: 'https://api.priorbank.by:9544/oauth2/token', nonce: 'n1', state: 's1',
    nowSec: 1_700_000_000, jti: 'j1'
  }

  type Claims = {
    claims: { userinfo: Record<string, unknown>, id_token: Record<string, unknown> }
    aud: string[]
    iat: number
    exp: number
    client_id: string
    iss: string
    sub: string
  }

  it('binds openbanking_intent_id in both userinfo and id_token, aud is an array, exp = iat + ttl', () => {
    const claims = buildAuthorizeRequestClaims(claimsInput) as Claims
    expect(claims.claims.userinfo.openbanking_intent_id).toEqual({ value: 'INTENT-1', essential: true })
    expect(claims.claims.id_token.openbanking_intent_id).toEqual({ value: 'INTENT-1', essential: true })
    expect(Array.isArray(claims.aud)).toBe(true)
    expect(claims.aud[0]).toBe(claimsInput.aud)
    expect(claims.iat).toBe(1_700_000_000)
    expect(claims.exp).toBe(1_700_000_000 + 600)
    expect(claims.client_id).toBe('CID')
    expect(claims.iss).toBe('CID')
    expect(claims.sub).toBe('CID')
  })

  it('custom ttl is honoured', () => {
    const claims = buildAuthorizeRequestClaims({ ...claimsInput, ttlSec: 120 }) as Claims
    expect(claims.exp).toBe(claimsInput.nowSec + 120)
  })

  it('authorize URL applies the AUTH prefix, carries the signed request JWT, throws on empty base', () => {
    const url = buildPriorAuthorizeUrl('https://api.priorbank.by:9344', {
      clientId: 'CID', redirectUri: 'https://cb/ob', state: 's1', requestJwt: 'HEAD.PAY.SIG'
    })
    const u = new URL(url)
    expect(u.pathname).toBe(`${PRIOR_API_PREFIXES.AUTH}/oauth2/authorize`)
    expect(u.searchParams.get('client_id')).toBe('CID')
    expect(u.searchParams.get('request')).toBe('HEAD.PAY.SIG')
    expect(u.searchParams.get('prompt')).toBe('login')
    expect(u.searchParams.get('scope')).toBe('openid accounts')
    expect(() => buildPriorAuthorizeUrl('', { clientId: 'x', redirectUri: 'y', state: 'z', requestJwt: 'j' })).toThrow()
  })
})

describe('resource request body — statements vs transactions date formats', () => {
  it('statements want bare yyyy-MM-dd', () => {
    const body = buildResourceRequestBody('statements', '2026-06-01', '2026-06-30')
    expect(body.data.statement).toEqual({ fromBookingDate: '2026-06-01', toBookingDate: '2026-06-30' })
  })

  it('transactions want full ISO datetime with +03:00 offset', () => {
    const body = buildResourceRequestBody('transactions', '2026-06-01', '2026-06-30')
    expect(body.data.transaction).toEqual({
      fromBookingDate: '2026-06-01T00:00:00+03:00',
      toBookingDate: '2026-06-30T23:59:59+03:00'
    })
  })
})

describe('window limit', () => {
  it('accepts ≤ 3 months, rejects wider / inverted / invalid', () => {
    expect(isWindowWithinLimit('2026-06-01', '2026-06-30')).toBe(true)
    expect(isWindowWithinLimit('2026-01-01', '2026-06-30')).toBe(false)
    expect(isWindowWithinLimit('2026-06-30', '2026-06-01')).toBe(false)
    expect(isWindowWithinLimit('not-a-date', '2026-06-30')).toBe(false)
  })

  it('is inclusive exactly at PRIOR_MAX_WINDOW_DAYS and rejects one day past it', () => {
    // 2026-06-01 → 2026-09-02 is exactly 93 days (PRIOR_MAX_WINDOW_DAYS); +1 day is over.
    expect(isWindowWithinLimit('2026-06-01', '2026-09-02')).toBe(true)
    expect(isWindowWithinLimit('2026-06-01', '2026-09-03')).toBe(false)
  })
})

describe('token response parsing', () => {
  it('normalizes a full token set', () => {
    const set = parsePriorTokenResponse({ access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer', expires_in: 3600, scope: 'accounts' })
    expect(set).toEqual({ accessToken: 'AT', refreshToken: 'RT', tokenType: 'Bearer', expiresIn: 3600, scope: 'accounts' })
  })

  it('client_credentials response (no refresh_token) is valid', () => {
    const set = parsePriorTokenResponse({ access_token: 'AT', expires_in: 300, scope: 'accounts' })
    expect(set.accessToken).toBe('AT')
    expect(set.refreshToken).toBeUndefined()
  })

  it('throws on an OAuth error payload and on a missing access token', () => {
    expect(() => parsePriorTokenResponse({ error: 'invalid_grant', error_description: 'bad code' })).toThrow(/invalid_grant/)
    expect(() => parsePriorTokenResponse({})).toThrow(/missing access_token/)
  })

  it('error without a description does not append " — undefined"', () => {
    expect(() => parsePriorTokenResponse({ error: 'invalid_client' })).toThrow(/Priorbank OAuth error: invalid_client$/)
  })
})

describe('response extraction', () => {
  it('extractIntentId accepts every field-name revision', () => {
    expect(extractIntentId({ data: { consentId: 'A' } })).toBe('A')
    expect(extractIntentId({ data: { accountConsentId: 'B' } })).toBe('B')
    expect(extractIntentId({ openbanking_intent_id: 'C' })).toBe('C')
    expect(extractIntentId({ data: { ConsentId: 'D' } })).toBe('D')
    expect(extractIntentId({ data: {} })).toBeNull()
  })

  it('extractResourceId reads statementId / transactionListId / generic id', () => {
    expect(extractResourceId('statements', { data: { statement: { statementId: 'S1' } } })).toBe('S1')
    expect(extractResourceId('transactions', { data: { transaction: { transactionListId: 'T1' } } })).toBe('T1')
    expect(extractResourceId('statements', { data: { id: 'G1' } })).toBe('G1')
    expect(extractResourceId('statements', { data: {} })).toBeNull()
  })

  it('extractAccounts tolerates data.account / data.accounts / casing variants', () => {
    const rows = extractAccounts({
      data: {
        account: [
          { accountId: 'a1', currency: 'BYN', accountDetails: { identification: 'BY10...' }, accountSubType: 'CurrentAccount' },
          { AccountId: 'a2', currIso: 'USD', number: '3012...' }
        ]
      }
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ accountId: 'a1', currency: 'BYN', identification: 'BY10...', accountSubType: 'CurrentAccount' })
    expect(rows[1]!.accountId).toBe('a2')
    expect(rows[1]!.currency).toBe('USD')
    expect(rows[1]!.identification).toBe('3012...')
  })

  it('extractAccounts tolerates a bare array (no data envelope)', () => {
    const rows = extractAccounts([{ accountId: 'a1', currency: 'BYN' }])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.accountId).toBe('a1')
  })

  it('extractAccounts returns [] on an empty/odd shape', () => {
    expect(extractAccounts({ data: {} })).toEqual([])
    expect(extractAccounts(null)).toEqual([])
  })
})
