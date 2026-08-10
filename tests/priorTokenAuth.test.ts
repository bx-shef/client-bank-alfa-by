import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { priorAuthMethodFromEnv, resolvePriorTokenAuth, type PriorAuthConfig } from '../server/utils/priorTokenAuth'
import { priorRefreshAuthFromEnv } from '../server/utils/ensureBankToken'
import { PRIOR_ASSERTION_TTL_SEC } from '../app/utils/priorOauth'

const config: PriorAuthConfig = {
  clientId: 'CID',
  clientSecret: 'SEC',
  audience: 'https://api.priorbank.by:9544/oauth2/token',
  privateKeyPem: '-----BEGIN PRIVATE KEY-----FAKE-----END PRIVATE KEY-----',
  kid: 'prior-key-1'
}

function fakeDeps() {
  const signed: { payload: Record<string, unknown>, pem: string, kid: string }[] = []
  let n = 0
  return {
    signed,
    deps: {
      signJwt: (payload: Record<string, unknown>, pem: string, kid: string) => {
        signed.push({ payload, pem, kid })
        return `SIGNED-${signed.length}`
      },
      nowSec: () => 1_700_000_000,
      newId: () => `jti-${++n}`
    }
  }
}

describe('priorAuthMethodFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to the sandbox method when unset', () => {
    vi.stubEnv('PRIOR_OAUTH_AUTH_METHOD', '')
    expect(priorAuthMethodFromEnv()).toBe('client_secret_basic')
  })

  it('reads private_key_jwt when configured', () => {
    vi.stubEnv('PRIOR_OAUTH_AUTH_METHOD', 'private_key_jwt')
    expect(priorAuthMethodFromEnv()).toBe('private_key_jwt')
  })

  it('an unknown value keeps the working sandbox method (fail-safe)', () => {
    vi.stubEnv('PRIOR_OAUTH_AUTH_METHOD', 'tls_client_auth')
    expect(priorAuthMethodFromEnv()).toBe('client_secret_basic')
  })
})

// The REAL production wiring: 5 env vars → config → the real signPriorJwt/randomUUID/Date.now.
// Unit tests of the pure builders don't touch it, so a typo in an env name or a swallowed error
// would pass CI and surface as a 401 in production — the same class of gap `reconScriptsSmoke`
// exists for.
describe('priorRefreshAuthFromEnv (live env wiring)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function stubPrior(over: Record<string, string> = {}) {
    const env: Record<string, string> = {
      PRIOR_OAUTH_CLIENT_ID: 'CID',
      PRIOR_OAUTH_CLIENT_SECRET: 'SEC',
      PRIOR_OAUTH_AUDIENCE: 'https://api.priorbank.by:9544/oauth2/token',
      PRIOR_OAUTH_KID: 'prior-key-1',
      PRIOR_OAUTH_PRIVATE_KEY: '',
      PRIOR_OAUTH_AUTH_METHOD: '',
      ...over
    }
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  }

  it('null when Prior is not configured at all', () => {
    stubPrior({ PRIOR_OAUTH_CLIENT_ID: '' })
    expect(priorRefreshAuthFromEnv()).toBeNull()
  })

  it('client_secret_basic by default, reading the creds from env', () => {
    stubPrior()
    expect(priorRefreshAuthFromEnv()).toEqual({ method: 'client_secret_basic', clientId: 'CID', clientSecret: 'SEC' })
  })

  it('private_key_jwt signs a REAL assertion with the env key (end-to-end, no stubbed signer)', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    stubPrior({
      PRIOR_OAUTH_AUTH_METHOD: 'private_key_jwt',
      PRIOR_OAUTH_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    })

    const auth = priorRefreshAuthFromEnv()
    expect(auth?.method).toBe('private_key_jwt')
    const jwt = (auth as { assertion: string }).assertion
    const [rawHeader, rawPayload, sig] = jwt.split('.')
    expect(sig).toBeTruthy()

    // Decode what the bank will actually receive — this is what a stubbed signer cannot prove.
    const header = JSON.parse(Buffer.from(rawHeader!, 'base64url').toString())
    const claims = JSON.parse(Buffer.from(rawPayload!, 'base64url').toString())
    expect(header.alg).toBe('RS256')
    expect(header.kid).toBe('prior-key-1')
    expect(claims.iss).toBe('CID')
    expect(claims.sub).toBe('CID')
    expect(claims.aud).toEqual(['https://api.priorbank.by:9544/oauth2/token'])
    expect(claims.exp - claims.iat).toBe(PRIOR_ASSERTION_TTL_SEC)
    expect(jwt).not.toContain('SEC') // the client secret never rides in the assertion
  })

  it('works without a client secret under private_key_jwt (the bank may not issue one)', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    stubPrior({
      PRIOR_OAUTH_CLIENT_SECRET: '',
      PRIOR_OAUTH_AUTH_METHOD: 'private_key_jwt',
      PRIOR_OAUTH_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    })
    expect(priorRefreshAuthFromEnv()?.method).toBe('private_key_jwt')
  })

  // The regression this guards: swallowing the error here made the caller fall back to Basic and
  // send the real client secret to a token endpoint registered for private_key_jwt only — an
  // opaque 401 that reads like an ordinary refresh failure.
  it('THROWS (never degrades to Basic) when private_key_jwt is selected but the key is missing', () => {
    stubPrior({ PRIOR_OAUTH_AUTH_METHOD: 'private_key_jwt', PRIOR_OAUTH_PRIVATE_KEY: '' })
    expect(() => priorRefreshAuthFromEnv()).toThrow(/private_key_jwt needs/)
  })
})

describe('resolvePriorTokenAuth', () => {
  it('client_secret_basic passes the creds through, without touching the signer', () => {
    const { deps, signed } = fakeDeps()
    expect(resolvePriorTokenAuth('client_secret_basic', config, deps))
      .toEqual({ method: 'client_secret_basic', clientId: 'CID', clientSecret: 'SEC' })
    expect(signed).toHaveLength(0)
  })

  it('private_key_jwt signs a fresh assertion with the registered kid', () => {
    const { deps, signed } = fakeDeps()
    const auth = resolvePriorTokenAuth('private_key_jwt', config, deps)

    expect(auth).toEqual({ method: 'private_key_jwt', assertion: 'SIGNED-1' })
    expect(signed).toHaveLength(1)
    expect(signed[0]!.kid).toBe('prior-key-1')
    expect(signed[0]!.pem).toBe(config.privateKeyPem)

    const claims = signed[0]!.payload
    expect(claims.iss).toBe('CID')
    expect(claims.sub).toBe('CID')
    expect(claims.aud).toEqual([config.audience])
    expect(claims.exp).toBe(1_700_000_000 + PRIOR_ASSERTION_TTL_SEC)
  })

  it('mints a NEW assertion per call — assertions are single-use (unique jti)', () => {
    const { deps, signed } = fakeDeps()
    const a = resolvePriorTokenAuth('private_key_jwt', config, deps)
    const b = resolvePriorTokenAuth('private_key_jwt', config, deps)
    expect(a).not.toEqual(b)
    expect(signed[0]!.payload.jti).not.toBe(signed[1]!.payload.jti)
  })

  it('never leaks the client secret into the assertion claims', () => {
    const { deps, signed } = fakeDeps()
    resolvePriorTokenAuth('private_key_jwt', config, deps)
    expect(JSON.stringify(signed[0]!.payload)).not.toContain('SEC')
  })

  // Falling back to Basic here would ship sandbox-only credentials to production and surface as an
  // opaque 401 far from the misconfiguration — fail loudly at the source instead.
  it.each([
    ['privateKeyPem', { privateKeyPem: '' }],
    ['kid', { kid: '' }],
    ['audience', { audience: '' }]
  ])('throws (never silently falls back to Basic) when %s is missing', (_name, patch) => {
    const { deps } = fakeDeps()
    expect(() => resolvePriorTokenAuth('private_key_jwt', { ...config, ...patch }, deps))
      .toThrow(/private_key_jwt needs/)
  })
})
