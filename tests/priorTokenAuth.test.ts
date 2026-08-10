import { afterEach, describe, expect, it, vi } from 'vitest'
import { priorAuthMethodFromEnv, resolvePriorTokenAuth, type PriorAuthConfig } from '../server/utils/priorTokenAuth'
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
