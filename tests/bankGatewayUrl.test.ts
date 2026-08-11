import { describe, expect, it } from 'vitest'
import { normalizeAuthorizeBase, normalizeBankApiBase, sameOrigin } from '../app/utils/bankGatewayUrl'

describe('normalizeBankApiBase (origin the BACKEND calls)', () => {
  it('accepts https anywhere and strips trailing slashes', () => {
    expect(normalizeBankApiBase('https://api.priorbank.by:9344/')).toBe('https://api.priorbank.by:9344')
    expect(normalizeBankApiBase('  https://apibel.priorbank.by:9345//  ')).toBe('https://apibel.priorbank.by:9345')
  })

  // The whole point of the gateway: it takes plain HTTP from us on an internal network and raises
  // the BY-crypto TLS itself. Requiring https everywhere would forbid the real deployment.
  it.each([
    'http://localhost:1080',
    'http://127.0.0.1:1080',
    'http://avtunproxy:1080', // docker compose service name (single label)
    'http://10.0.0.5:1080',
    'http://192.168.1.10:1080',
    'http://172.20.0.3:1080'
  ])('accepts http for the internal gateway: %s', (url) => {
    expect(normalizeBankApiBase(url)).toBe(url)
  })

  // A typo here would send the Bearer token — and under client_secret_basic the client secret —
  // across the open network in clear text.
  it.each([
    'http://api.priorbank.by:9344',
    'http://evil.example.com',
    'http://8.8.8.8'
  ])('rejects http to a PUBLIC host: %s', (url) => {
    expect(normalizeBankApiBase(url)).toBeNull()
  })

  it.each(['', '   ', undefined, null, '/relative', 'api.priorbank.by', 'ftp://host'])(
    'rejects unusable value: %s', (v) => {
      expect(normalizeBankApiBase(v)).toBeNull()
    })
})

describe('normalizeAuthorizeBase (origin the BROWSER opens)', () => {
  it('accepts the bank public https origin', () => {
    expect(normalizeAuthorizeBase('https://api.priorbank.by:9344/')).toBe('https://api.priorbank.by:9344')
  })

  // THE failure this module exists for: an internal gateway address here produces a URL the admin's
  // browser cannot open, and the server never notices because it never makes that request.
  it.each([
    'http://localhost:1080',
    'https://localhost:1080',
    'http://avtunproxy:1080',
    'https://avtunproxy:1080',
    'https://10.0.0.5'
  ])('rejects an internal address: %s', (url) => {
    expect(normalizeAuthorizeBase(url)).toBeNull()
  })

  it('rejects plain http even on a public host (a browser navigation must be TLS)', () => {
    expect(normalizeAuthorizeBase('http://api.priorbank.by:9344')).toBeNull()
  })
})

describe('sameOrigin', () => {
  it('true for the same origin regardless of path', () => {
    expect(sameOrigin('https://h:9344', 'https://h:9344/open-banking-authorize/v1.0/oauth2/token')).toBe(true)
  })

  // The drift this guards: move API_BASE onto the gateway, forget TOKEN_URL, and refresh keeps
  // quietly talking to the old host until the import stops.
  it('false when host or port differ', () => {
    expect(sameOrigin('http://avtunproxy:1080', 'https://api.priorbank.by:9344/token')).toBe(false)
    expect(sameOrigin('https://h:9344', 'https://h:9345')).toBe(false)
  })

  it('false on unparsable input rather than throwing', () => {
    expect(sameOrigin('', 'https://h')).toBe(false)
    expect(sameOrigin(undefined, null)).toBe(false)
  })
})
