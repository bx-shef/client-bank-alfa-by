import { describe, expect, it } from 'vitest'
import {
  PRIOR_API_PREFIXES,
  PRIOR_CLIENT_ASSERTION_TYPE,
  PRIOR_ASSERTION_TTL_SEC,
  PRIOR_FAPI_INTERACTION_HEADER,
  priorResourceHeaders,
  priorWriteHeaders,
  PRIOR_IDEMPOTENCY_HEADER,
  CONSENT_PERMISSIONS,
  buildBasicAuthHeader,
  buildClientAssertionClaims,
  parsePriorAuthMethod,
  priorTokenRequest,
  buildClientCredentialsBody,
  buildCodeExchangeBody,
  buildPriorRefreshBody,
  buildRegistrationMetadata,
  buildPriorClientName,
  isSafePriorClientName,
  buildConsentRequest,
  buildAuthorizeRequestClaims,
  buildPriorAuthorizeUrl,
  buildResourceRequestBody,
  isWindowWithinLimit,
  parsePriorTokenResponse,
  extractIntentId,
  extractResourceId,
  extractAccounts,
  buildPriorResourceCreatePath,
  buildPriorResourcePollPath,
  extractPriorErrorCodes,
  classifyPriorPoll,
  PRIOR_RESOURCE_NOT_CREATED
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
    // PINNED value, not just the shape (#444): the default is the SANDBOX-ONLY method. When this
    // flips to private_key_jwt, this test must go red — that is the reminder to migrate ALL FOUR
    // token-endpoint call sites, since DCR registers one method per application.
    expect(meta.token_endpoint_auth_method).toEqual(['client_secret_basic'])
    expect(typeof meta.jwks).toBe('string')
    expect(JSON.parse(meta.jwks as string)).toEqual(jwks)
    expect(meta.redirect_uris).toEqual(['https://cb/ob'])
    expect(meta.client_name).toBe('App')
  })

  it('omits jwks when none is provided', () => {
    const meta = buildRegistrationMetadata({ clientName: 'App', redirectUri: 'https://cb/ob' })
    expect('jwks' in meta).toBe(false)
  })

  it('registers the requested auth method (prod needs private_key_jwt)', () => {
    const meta = buildRegistrationMetadata({
      clientName: 'App',
      redirectUri: 'https://cb/ob',
      tokenEndpointAuthMethod: 'private_key_jwt'
    })
    expect(meta.token_endpoint_auth_method).toEqual(['private_key_jwt'])
  })

  // The name that actually shipped: Cyrillic and spaces. `/register` answered 201, and the store
  // side of WSO2 cannot represent it. Registering is one-way (no working PUT), so this has to fail
  // BEFORE the request, not after.
  it('refuses a client_name the API Store cannot represent', () => {
    expect(() => buildRegistrationMetadata({
      clientName: 'Импорт выписки Bitrix24 basic 0812-162429',
      redirectUri: 'https://cb/ob'
    })).toThrow(/client_name/)
    expect(() => buildRegistrationMetadata({ clientName: 'has space', redirectUri: 'https://cb/ob' })).toThrow()
    expect(() => buildRegistrationMetadata({ clientName: 'paren(s)', redirectUri: 'https://cb/ob' })).toThrow()
    expect(() => buildRegistrationMetadata({ clientName: '', redirectUri: 'https://cb/ob' })).toThrow()
  })

  // `default_max_age` is only absent when we say nothing; 0 must reach the bank as 0, because
  // "omit it" and "ask for no constraint" are different requests and the bank's own default is 900.
  it('sends default_max_age only when asked, and 0 is a value, not an omission', () => {
    const bare = buildRegistrationMetadata({ clientName: 'App', redirectUri: 'https://cb/ob' })
    expect('default_max_age' in bare).toBe(false)
    const zero = buildRegistrationMetadata({ clientName: 'App', redirectUri: 'https://cb/ob', defaultMaxAge: 0 })
    expect(zero.default_max_age).toBe(0)
    const some = buildRegistrationMetadata({ clientName: 'App', redirectUri: 'https://cb/ob', defaultMaxAge: 3600 })
    expect(some.default_max_age).toBe(3600)
  })
})

describe('buildPriorClientName', () => {
  it('joins parts into a store-safe name', () => {
    expect(buildPriorClientName(['bx-shef', 'bank-import', 'client_secret_basic', '20260813T0612']))
      .toBe('bx-shef-bank-import-client_secret_basic-20260813T0612')
  })

  it('replaces unsafe characters instead of dropping them (dropping can collide)', () => {
    // Two DIFFERENT inputs must not become one name — a collision is a 409 and a wasted
    // registration, and with dropping, `a b` and `ab` would both become `ab`.
    expect(buildPriorClientName(['a b'])).toBe('a-b')
    expect(buildPriorClientName(['ab'])).toBe('ab')
    expect(buildPriorClientName(['Импорт выписки', 'Bitrix24'])).toBe('Bitrix24')
  })

  it('collapses runs, trims edges, and stays inside the pattern', () => {
    expect(buildPriorClientName(['a  b', '', '-c-'])).toBe('a-b-c')
    expect(isSafePriorClientName(buildPriorClientName(['x!!!y']))).toBe(true)
  })

  it('caps the length (WSO2 rejects long application names)', () => {
    expect(buildPriorClientName(['x'.repeat(200)])).toHaveLength(100)
  })

  it('throws rather than returning an empty name', () => {
    expect(() => buildPriorClientName(['—', '  '])).toThrow(/empty/)
  })
})

describe('client authentication at the token endpoint (#444)', () => {
  describe('parsePriorAuthMethod', () => {
    it('accepts the two supported methods', () => {
      expect(parsePriorAuthMethod('private_key_jwt')).toBe('private_key_jwt')
      expect(parsePriorAuthMethod('client_secret_basic')).toBe('client_secret_basic')
      expect(parsePriorAuthMethod('  private_key_jwt  ')).toBe('private_key_jwt')
    })
    it('falls back to the sandbox method on blank/unknown (fail-SAFE, not fail-closed)', () => {
      // Deliberate: an unknown value must not silently arm a prod method the app may not be
      // registered for — keep today's working behaviour instead.
      for (const raw of ['', '   ', undefined, null, 'tls_client_auth', 'nonsense']) {
        expect(parsePriorAuthMethod(raw)).toBe('client_secret_basic')
      }
    })
  })

  describe('buildClientAssertionClaims', () => {
    const claims = buildClientAssertionClaims({
      clientId: 'CID', aud: 'https://api.priorbank.by:9544/oauth2/token', nowSec: 1_757_588_736, jti: 'J1'
    })

    it('matches the bank documented shape: iss=sub=client id, aud is an ARRAY', () => {
      expect(claims.iss).toBe('CID')
      expect(claims.sub).toBe('CID')
      // ARRAY, per the guide's §4.1.2 example — a bare string is a different claim shape.
      expect(claims.aud).toEqual(['https://api.priorbank.by:9544/oauth2/token'])
      expect(claims.jti).toBe('J1')
      expect(claims.iat).toBe(1_757_588_736)
    })

    it('is short-lived and expires strictly after it is issued', () => {
      expect(claims.exp).toBe(1_757_588_736 + PRIOR_ASSERTION_TTL_SEC)
      expect(claims.exp as number).toBeGreaterThan(claims.iat as number)
      expect(PRIOR_ASSERTION_TTL_SEC).toBeLessThanOrEqual(600)
    })

    it('carries NO authorize-request claims (a distinct JWT from buildAuthorizeRequestClaims)', () => {
      for (const k of ['response_type', 'redirect_uri', 'nonce', 'state', 'claims', 'scope', 'client_id']) {
        expect(claims[k], k).toBeUndefined()
      }
    })

    it('honours a custom ttl', () => {
      const c = buildClientAssertionClaims({ clientId: 'C', aud: 'A', nowSec: 100, jti: 'J', ttlSec: 30 })
      expect(c.exp).toBe(130)
    })
  })

  describe('priorTokenRequest', () => {
    const body = () => new URLSearchParams({ grant_type: 'client_credentials', scope: 'accounts' })

    it('client_secret_basic: creds in the HEADER, never in the body', () => {
      const r = priorTokenRequest(body(), { method: 'client_secret_basic', clientId: 'CID', clientSecret: 'SEC' })
      expect(r.headers.authorization).toBe(buildBasicAuthHeader('CID', 'SEC'))
      expect(r.body).toBe('grant_type=client_credentials&scope=accounts')
      expect(r.body).not.toContain('SEC')
      expect(r.body).not.toContain('client_assertion')
    })

    it('private_key_jwt: assertion in the BODY, no auth header', () => {
      const r = priorTokenRequest(body(), { method: 'private_key_jwt', assertion: 'H.P.S' })
      expect(r.headers).toEqual({})
      const form = new URLSearchParams(r.body)
      expect(form.get('client_assertion')).toBe('H.P.S')
      expect(form.get('client_assertion_type')).toBe(PRIOR_CLIENT_ASSERTION_TYPE)
      // The grant params survive alongside the client authentication.
      expect(form.get('grant_type')).toBe('client_credentials')
      expect(form.get('scope')).toBe('accounts')
    })

    it('does not mutate the caller body (it may be reused/logged)', () => {
      const b = body()
      priorTokenRequest(b, { method: 'private_key_jwt', assertion: 'H.P.S' })
      expect(b.has('client_assertion')).toBe(false)
    })

    it('throws on an empty assertion rather than sending an unauthenticated request', () => {
      expect(() => priorTokenRequest(body(), { method: 'private_key_jwt', assertion: '' }))
        .toThrow(/client_assertion/)
    })
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

describe('async resource paths + poll classification (A5b)', () => {
  it('buildPriorResourceCreatePath / PollPath under the OB prefix', () => {
    expect(buildPriorResourceCreatePath('transactions', 'ACC-1')).toBe(`${PRIOR_API_PREFIXES.OB}/accounts/ACC-1/transactions`)
    expect(buildPriorResourceCreatePath('statements', 'ACC-1')).toBe(`${PRIOR_API_PREFIXES.OB}/accounts/ACC-1/statements`)
    expect(buildPriorResourcePollPath('transactions', 'ACC-1', 'R9')).toBe(`${PRIOR_API_PREFIXES.OB}/accounts/ACC-1/transactions/R9`)
  })

  it('extractPriorErrorCodes tolerates errors[] / Errors[] / bare {code} / {error}', () => {
    expect(extractPriorErrorCodes({ errors: [{ code: 'A' }, { Code: 'B' }, { errorCode: 'C' }] })).toEqual(['A', 'B', 'C'])
    expect(extractPriorErrorCodes({ Errors: [{ Code: 'X' }] })).toEqual(['X'])
    expect(extractPriorErrorCodes({ code: 'Y' })).toEqual(['Y'])
    expect(extractPriorErrorCodes({ error: 'Z' })).toEqual(['Z'])
    expect(extractPriorErrorCodes({ data: { transaction: [] } })).toEqual([]) // ready — no error node
    expect(extractPriorErrorCodes(null)).toEqual([])
  })

  it('classifyPriorPoll: pending (NotCreated) / ready / hard error', () => {
    expect(classifyPriorPoll({ errors: [{ code: PRIOR_RESOURCE_NOT_CREATED }] })).toEqual({ status: 'pending' })
    expect(classifyPriorPoll({ data: { transaction: [] } })).toEqual({ status: 'ready' })
    expect(classifyPriorPoll({ errors: [{ code: 'BY.NBRB.Field.InvalidDate' }] })).toEqual({ status: 'error', codes: ['BY.NBRB.Field.InvalidDate'] })
  })
})

describe('priorResourceHeaders (#461)', () => {
  it('carries the FAPI interaction header the bank rejects requests without', () => {
    // 400 BY.NBRB.Header.Missing — измерено на sandbox 2026-08-12. Без него ресурсный API
    // отказывает ещё до проверки прав, и снаружи это выглядит опаковым 502 на подключении.
    const h = priorResourceHeaders('tok', 'id-1')
    expect(h['x-fapi-interaction-id']).toBe('id-1')
    expect(h.authorization).toBe('Bearer tok')
  })

  it('a READ carries neither content-type nor an idempotency key', () => {
    const h = priorResourceHeaders('t', 'i')
    expect(h['content-type']).toBeUndefined()
    expect(h['x-idempotency-key']).toBeUndefined()
  })

  it('the header name is exactly what the bank asks for', () => {
    // Регистр и дефисы — как в тексте ошибки банка; опечатка здесь не поймается ничем другим.
    expect(PRIOR_FAPI_INTERACTION_HEADER).toBe('x-fapi-interaction-id')
    expect(PRIOR_IDEMPOTENCY_HEADER).toBe('x-idempotency-key')
  })
})

describe('priorWriteHeaders (#461)', () => {
  it('carries BOTH mandatory headers plus the JSON content type', () => {
    // 400 BY.NBRB.Header.Missing на x-idempotency-key — измерено на sandbox 2026-08-12: банк
    // проверяет заголовки ДО тела (четыре разных тела дали одну и ту же ошибку).
    const h = priorWriteHeaders('tok', 'int-1', 'idem-1')
    expect(h.authorization).toBe('Bearer tok')
    expect(h['x-fapi-interaction-id']).toBe('int-1')
    expect(h['x-idempotency-key']).toBe('idem-1')
    expect(h['content-type']).toBe('application/json')
  })

  it('is a superset of the read headers — one choke point, not two divergent copies', () => {
    const read = priorResourceHeaders('tok', 'int-1')
    const write = priorWriteHeaders('tok', 'int-1', 'idem-1')
    for (const [k, v] of Object.entries(read)) expect(write[k]).toBe(v)
  })
})
