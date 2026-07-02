import { describe, expect, it } from 'vitest'
import {
  authStartupWarning,
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

  it('treats exp exactly equal to now as expired (boundary is <=)', () => {
    expect(verifySession(signSession({ sub: 'operator', exp: now }, secret), secret, now)).toBeNull()
    expect(verifySession(signSession({ sub: 'operator', exp: now + 1 }, secret), secret, now))
      .toEqual({ sub: 'operator', exp: now + 1 })
  })

  it('rejects a well-signed payload with a missing or non-numeric exp', () => {
    // Sign a body that parses as JSON but lacks a numeric `exp`.
    const bad = { sub: 'operator', exp: 'soon' } as unknown as { sub: string, exp: number }
    expect(verifySession(signSession(bad, secret), secret, now)).toBeNull()
    const noExp = { sub: 'operator' } as unknown as { sub: string, exp: number }
    expect(verifySession(signSession(noExp, secret), secret, now)).toBeNull()
  })
})

describe('authStartupWarning', () => {
  it('is silent outside production regardless of config', () => {
    expect(authStartupWarning({})).toBeNull()
    expect(authStartupWarning({ NODE_ENV: 'development' })).toBeNull()
    expect(authStartupWarning({ NODE_ENV: 'test', PUBLIC_PAGE_BASIC_AUTH_PASS: 'p' })).toBeNull()
  })

  it('warns in production when no password is set (zone open)', () => {
    const w = authStartupWarning({ NODE_ENV: 'production' })
    expect(w).toMatch(/OPEN/)
    expect(w).toMatch(/PUBLIC_PAGE_BASIC_AUTH_PASS/)
  })

  it('warns in production when the signing secret is derived from the password', () => {
    const w = authStartupWarning({ NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 'p' })
    expect(w).toMatch(/SESSION_SECRET/)
  })

  it('is silent in production when both password and an explicit secret are set', () => {
    expect(authStartupWarning({ NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 'p', SESSION_SECRET: 'K' })).toBeNull()
  })

  it('never leaks the password or secret in the warning text', () => {
    const w = authStartupWarning({ NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 's3cret-pw' })
    expect(w).not.toMatch(/s3cret-pw/)
  })
})
