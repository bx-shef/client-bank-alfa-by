import { describe, expect, it } from 'vitest'
import {
  checkCredentials,
  isAuthConfigured,
  resolveAuthConfig,
  signSession,
  verifySession
} from '../server/utils/session'

// Operator login core (see docs/AUTH.md): env config, constant-time credential
// check, HMAC-signed session cookie. Pure — no requests here.

describe('resolveAuthConfig', () => {
  it('defaults: user "operator", ttl 12h, no pass ⇒ not configured', () => {
    const cfg = resolveAuthConfig({})
    expect(cfg.user).toBe('operator')
    expect(cfg.pass).toBe('')
    expect(cfg.ttlMs).toBe(12 * 3_600_000)
    expect(isAuthConfigured(cfg)).toBe(false)
    expect(cfg.secret).toBe('') // no pass ⇒ no derived secret (never sign with '')
  })

  it('reads user/pass, derives secret from pass when SESSION_SECRET unset', () => {
    const cfg = resolveAuthConfig({ PUBLIC_PAGE_BASIC_AUTH_USER: 'admin', PUBLIC_PAGE_BASIC_AUTH_PASS: 's3cret' })
    expect(cfg.user).toBe('admin')
    expect(isAuthConfigured(cfg)).toBe(true)
    expect(cfg.secret).toBe('derived:s3cret')
  })

  it('explicit SESSION_SECRET wins; SESSION_TTL_HOURS override; invalid ttl → default', () => {
    expect(resolveAuthConfig({ PUBLIC_PAGE_BASIC_AUTH_PASS: 'p', SESSION_SECRET: 'K' }).secret).toBe('K')
    expect(resolveAuthConfig({ PUBLIC_PAGE_BASIC_AUTH_PASS: 'p', SESSION_TTL_HOURS: '2' }).ttlMs).toBe(2 * 3_600_000)
    expect(resolveAuthConfig({ PUBLIC_PAGE_BASIC_AUTH_PASS: 'p', SESSION_TTL_HOURS: 'nope' }).ttlMs).toBe(12 * 3_600_000)
  })
})

describe('checkCredentials', () => {
  const cfg = resolveAuthConfig({ PUBLIC_PAGE_BASIC_AUTH_USER: 'operator', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw' })
  it('accepts the exact pair, rejects wrong user/pass', () => {
    expect(checkCredentials('operator', 'pw', cfg)).toBe(true)
    expect(checkCredentials('operator', 'nope', cfg)).toBe(false)
    expect(checkCredentials('other', 'pw', cfg)).toBe(false)
  })
  it('rejects everything (incl. empty) when auth is not configured', () => {
    const none = resolveAuthConfig({})
    expect(checkCredentials('operator', '', none)).toBe(false)
    expect(checkCredentials('', '', none)).toBe(false)
  })
})

describe('signSession / verifySession', () => {
  const secret = 'test-secret'
  const now = 1_700_000_000_000

  it('round-trips a valid session', () => {
    const value = signSession({ sub: 'operator', exp: now + 1000 }, secret)
    expect(verifySession(value, secret, now)).toEqual({ sub: 'operator', exp: now + 1000 })
  })

  it('rejects a tampered body, tampered signature, and wrong secret', () => {
    const value = signSession({ sub: 'operator', exp: now + 1000 }, secret)
    const [body, sig] = value.split('.')
    expect(verifySession(`${body}X.${sig}`, secret, now)).toBeNull() // body tampered
    expect(verifySession(`${body}.${sig}X`, secret, now)).toBeNull() // sig tampered
    expect(verifySession(value, 'other-secret', now)).toBeNull() // wrong secret
  })

  it('rejects an expired session, empty secret, and garbage', () => {
    const value = signSession({ sub: 'operator', exp: now - 1 }, secret)
    expect(verifySession(value, secret, now)).toBeNull() // expired
    expect(verifySession(signSession({ sub: 'x', exp: now + 1 }, secret), '', now)).toBeNull() // empty secret
    expect(verifySession('garbage', secret, now)).toBeNull()
    expect(verifySession(undefined, secret, now)).toBeNull()
  })
})
