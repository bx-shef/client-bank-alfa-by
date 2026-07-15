import { describe, expect, it } from 'vitest'
import {
  authStartupWarning,
  checkCredentials,
  decideLogin,
  decideLogout,
  isAuthConfigured,
  operatorAllowed,
  resolveAuthConfig,
  sessionStatus,
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

  it('reads user/pass, derives secret from pass when SESSION_SECRET unset (dev)', () => {
    const cfg = resolveAuthConfig({ PUBLIC_PAGE_BASIC_AUTH_USER: 'admin', PUBLIC_PAGE_BASIC_AUTH_PASS: 's3cret' })
    expect(cfg.user).toBe('admin')
    expect(isAuthConfigured(cfg)).toBe(true)
    expect(cfg.secret).toBe('derived:s3cret')
  })

  it('#242 P1: in production the key is NOT derived from the password (fail-closed → empty secret)', () => {
    const cfg = resolveAuthConfig({ NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 's3cret' })
    expect(isAuthConfigured(cfg)).toBe(true) // password IS set…
    expect(cfg.secret).toBe('') // …but no derived key: sessions can't be signed/verified
    // explicit SESSION_SECRET still works in production
    expect(resolveAuthConfig({ NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 'p', SESSION_SECRET: 'K' }).secret).toBe('K')
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

  it('warns in production when a password is set but SESSION_SECRET is missing (fail-closed lockout)', () => {
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

// The /api/auth/* route status matrix (the handlers only do the h3 I/O), #65.
describe('decideLogin', () => {
  const cfg = resolveAuthConfig({ PUBLIC_PAGE_BASIC_AUTH_USER: 'operator', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw' })
  const none = resolveAuthConfig({})
  const now = 1_700_000_000_000
  const ok = { user: 'operator', password: 'pw' }

  it('503 when auth is not configured — even before the body/CSRF checks', () => {
    expect(decideLogin(none, true, ok, now).status).toBe(503)
    expect(decideLogin(none, false, null, now).status).toBe(503) // config check wins
  })
  it('403 when the CSRF header is missing — even with an unparseable body', () => {
    expect(decideLogin(cfg, false, ok, now).status).toBe(403)
    expect(decideLogin(cfg, false, null, now).status).toBe(403) // CSRF check wins over 400
  })
  it('400 on an unparseable body (creds null), after config+CSRF pass', () => {
    expect(decideLogin(cfg, true, null, now).status).toBe(400)
  })
  it('401 on wrong credentials', () => {
    expect(decideLogin(cfg, true, { user: 'operator', password: 'nope' }, now).status).toBe(401)
    expect(decideLogin(cfg, true, { user: 'x', password: 'pw' }, now).status).toBe(401)
  })
  it('200 with a verifiable session cookie on correct credentials', () => {
    const d = decideLogin(cfg, true, ok, now)
    expect(d.status).toBe(200)
    if (d.status !== 200) throw new Error('unreachable')
    expect(d.body).toEqual({ ok: true, user: 'operator', exp: now + cfg.ttlMs })
    expect(d.cookie.name).toBe('cba_sess')
    expect(d.cookie.maxAgeSec).toBe(Math.floor(cfg.ttlMs / 1000))
    // The cookie is a valid signed session for this secret.
    expect(verifySession(d.cookie.value, cfg.secret, now)).toEqual({ sub: 'operator', exp: now + cfg.ttlMs })
  })
})

describe('decideLogout', () => {
  it('403 without the CSRF header, 200 with it', () => {
    expect(decideLogout(false)).toEqual({ status: 403, body: { error: 'missing csrf header' } })
    expect(decideLogout(true)).toEqual({ status: 200, body: { ok: true } })
  })
})

describe('sessionStatus', () => {
  const cfg = resolveAuthConfig({ PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw' })
  const now = 1_700_000_000_000

  it('authenticated with a valid cookie (includes user)', () => {
    const cookie = signSession({ sub: 'operator', exp: now + 1000 }, cfg.secret)
    expect(sessionStatus(cfg, cookie, now)).toEqual({ configured: true, authenticated: true, user: 'operator' })
  })
  it('configured but not authenticated on a missing/invalid/expired cookie (no user key)', () => {
    expect(sessionStatus(cfg, undefined, now)).toEqual({ configured: true, authenticated: false })
    expect(sessionStatus(cfg, 'garbage', now)).toEqual({ configured: true, authenticated: false })
    const expired = signSession({ sub: 'operator', exp: now - 1 }, cfg.secret)
    expect(sessionStatus(cfg, expired, now)).toEqual({ configured: true, authenticated: false })
  })
  it('reports configured:false when no password is set (gated pages open)', () => {
    expect(sessionStatus(resolveAuthConfig({}), undefined, now)).toEqual({ configured: false, authenticated: false })
  })
})

describe('operatorAllowed (server gate for /api/ops/*)', () => {
  const now = 1_000_000
  const configured = resolveAuthConfig({ PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw', SESSION_SECRET: 'K' })
  const open = resolveAuthConfig({}) // no password → zone open

  it('allows any request when auth is NOT configured (zone open)', () => {
    expect(operatorAllowed(open, undefined, now)).toBe(true)
    expect(operatorAllowed(open, 'anything', now)).toBe(true)
  })

  it('allows a valid, unexpired session cookie when configured', () => {
    const cookie = signSession({ sub: 'operator', exp: now + 10_000 }, configured.secret)
    expect(operatorAllowed(configured, cookie, now)).toBe(true)
  })

  it('denies a missing / forged / expired cookie when configured', () => {
    expect(operatorAllowed(configured, undefined, now)).toBe(false)
    expect(operatorAllowed(configured, 'not.a.valid.cookie', now)).toBe(false)
    const expired = signSession({ sub: 'operator', exp: now - 1 }, configured.secret)
    expect(operatorAllowed(configured, expired, now)).toBe(false)
    // signed with a different secret → signature mismatch
    const wrong = signSession({ sub: 'operator', exp: now + 10_000 }, 'OTHER')
    expect(operatorAllowed(configured, wrong, now)).toBe(false)
  })

  it('#242 P1: prod with a password but no SESSION_SECRET is fail-CLOSED (empty key denies all)', () => {
    const prodNoSecret = resolveAuthConfig({ NODE_ENV: 'production', PUBLIC_PAGE_BASIC_AUTH_PASS: 'pw' })
    // even a cookie minted with the (empty) config secret is rejected — the zone is locked,
    // never silently open, until an explicit SESSION_SECRET is provided.
    const cookie = signSession({ sub: 'operator', exp: now + 10_000 }, prodNoSecret.secret)
    expect(operatorAllowed(prodNoSecret, cookie, now)).toBe(false)
    expect(operatorAllowed(prodNoSecret, undefined, now)).toBe(false)
  })
})
