import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bankCredsFromEnv,
  bankRefreshRequest,
  ensureBankToken,
  needsBankRefresh,
  parseBankRefresh,
  type BankOAuthCreds,
  type BankRefreshDeps
} from '../server/utils/ensureBankToken'
import type { BankToken } from '../server/utils/bankTokenStore'

const NOW = 1_700_000_000_000
const creds: BankOAuthCreds = { clientId: 'cid', clientSecret: 'sec', tokenUrl: 'https://bank/token' }

const tok = (over: Partial<BankToken> = {}): BankToken => ({
  memberId: 'm1', provider: 'alfa-by', accountKey: 'MC_7',
  accessToken: 'A', refreshToken: 'R', expiresAt: NOW + 3_600_000, ...over
})

/** Deps that run `fn` immediately (no real lock), with a mutable stored token. */
function fakeDeps(over: Partial<BankRefreshDeps> & { stored?: BankToken | null, refreshRaw?: unknown } = {}) {
  const saved: BankToken[] = []
  const deps: BankRefreshDeps = {
    now: () => NOW,
    withLock: async (_key, fn) => fn((async () => []) as never),
    loadToken: async () => (over.stored === undefined ? tok() : over.stored),
    saveToken: async (_q, t) => { saved.push(t) },
    creds: () => creds,
    postRefresh: async () => over.refreshRaw ?? { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 },
    ...over
  }
  return { deps, saved }
}

describe('needsBankRefresh', () => {
  it('true within skew of expiry, false when comfortably fresh', () => {
    expect(needsBankRefresh(tok({ expiresAt: NOW + 30_000 }), NOW)).toBe(true) // 30s < 60s skew
    expect(needsBankRefresh(tok({ expiresAt: NOW + 3_600_000 }), NOW)).toBe(false)
    expect(needsBankRefresh(tok({ expiresAt: NOW - 1 }), NOW)).toBe(true) // already expired
  })
})

describe('bankRefreshRequest', () => {
  it('alfa: body carries client_id + client_secret + refresh_token', () => {
    const { url, body } = bankRefreshRequest('alfa-by', creds, 'R')
    expect(url).toBe('https://bank/token')
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=R')
    expect(body).toContain('client_id=cid')
    expect(body).toContain('client_secret=sec')
  })
  it('prior: body is grant_type + refresh_token (client auth via DCR client, not body)', () => {
    const { body } = bankRefreshRequest('prior-by', creds, 'R')
    expect(body).toBe('grant_type=refresh_token&refresh_token=R')
  })
  it('manual provider throws (no online OAuth)', () => {
    expect(() => bankRefreshRequest('manual', creds, 'R')).toThrow(/manual import only/)
  })
})

describe('parseBankRefresh', () => {
  it('alfa: maps access/refresh/expires', () => {
    expect(parseBankRefresh('alfa-by', { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 }))
      .toEqual({ accessToken: 'A2', refreshToken: 'R2', expiresIn: 3600 })
  })
  it('prior: tolerates a missing refresh_token (→ empty, caller keeps old)', () => {
    expect(parseBankRefresh('prior-by', { access_token: 'A2', expires_in: 900 }))
      .toEqual({ accessToken: 'A2', refreshToken: '', expiresIn: 900 })
  })
  it('propagates an OAuth error payload', () => {
    expect(() => parseBankRefresh('alfa-by', { error: 'invalid_grant' })).toThrow(/invalid_grant/)
  })
})

describe('ensureBankToken', () => {
  it('returns the token unchanged when comfortably fresh (no refresh)', async () => {
    const { deps, saved } = fakeDeps()
    const post = vi.fn(deps.postRefresh)
    const out = await ensureBankToken(tok(), { ...deps, postRefresh: post })
    expect(out.accessToken).toBe('A')
    expect(post).not.toHaveBeenCalled()
    expect(saved).toHaveLength(0)
  })

  it('refreshes + persists when near expiry, rotating access AND refresh', async () => {
    const near = tok({ expiresAt: NOW + 10_000 })
    const { deps, saved } = fakeDeps({ stored: near })
    const out = await ensureBankToken(near, deps)
    expect(out.accessToken).toBe('A2')
    expect(out.refreshToken).toBe('R2')
    expect(out.expiresAt).toBe(NOW + 3_600_000)
    expect(saved).toEqual([out]) // persisted the rotated token
  })

  it('keeps the old refresh token when the provider omits a new one (Prior)', async () => {
    const near = tok({ provider: 'prior-by', expiresAt: NOW + 10_000, refreshToken: 'OLD' })
    const { deps } = fakeDeps({ stored: near, refreshRaw: { access_token: 'A2', expires_in: 900 } })
    const out = await ensureBankToken(near, deps)
    expect(out.accessToken).toBe('A2')
    expect(out.refreshToken).toBe('OLD') // fell back to the stored one
  })

  it('no creds → returns the stored token as-is (cannot refresh)', async () => {
    const near = tok({ expiresAt: NOW - 1 })
    const post = vi.fn(async () => ({}))
    const { deps } = fakeDeps({ stored: near })
    const out = await ensureBankToken(near, { ...deps, creds: () => null, postRefresh: post })
    expect(out).toBe(near)
    expect(post).not.toHaveBeenCalled()
  })

  it('account disconnected between check and lock (stored=null) → no save, returns passed token', async () => {
    const near = tok({ expiresAt: NOW - 1 })
    const saveToken = vi.fn(async () => {})
    const { deps } = fakeDeps({ stored: null })
    const out = await ensureBankToken(near, { ...deps, saveToken })
    expect(out).toBe(near)
    expect(saveToken).not.toHaveBeenCalled()
  })

  it('force: refreshes a clock-fresh token, but only if the stored one is STILL the rejected token', async () => {
    // stored access token already rotated by a concurrent worker → use theirs, no re-refresh
    const rotated = tok({ accessToken: 'ROTATED' })
    const post = vi.fn(async () => ({ access_token: 'A3', refresh_token: 'R3', expires_in: 3600 }))
    const { deps } = fakeDeps({ stored: rotated })
    const out = await ensureBankToken(tok({ accessToken: 'OLD' }), { ...deps, postRefresh: post }, { force: true })
    expect(out.accessToken).toBe('ROTATED')
    expect(post).not.toHaveBeenCalled()
  })

  it('force: refreshes when the stored token IS still the rejected one', async () => {
    const stale = tok({ accessToken: 'OLD' })
    const { deps, saved } = fakeDeps({ stored: stale })
    const out = await ensureBankToken(tok({ accessToken: 'OLD' }), deps, { force: true })
    expect(out.accessToken).toBe('A2')
    expect(saved).toEqual([out])
  })

  it('locks per (member, provider, account)', async () => {
    const near = tok({ expiresAt: NOW + 10_000 })
    const withLock = vi.fn(async (_key: string, fn: (q: never) => Promise<unknown>) => fn(null as never))
    const { deps } = fakeDeps({ stored: near })
    await ensureBankToken(near, { ...deps, withLock })
    expect(withLock.mock.calls[0]![0]).toBe('bankrefresh:m1:alfa-by:MC_7')
  })
})

describe('bankCredsFromEnv', () => {
  const KEYS = ['ALFA_OAUTH_CLIENT_ID', 'ALFA_OAUTH_CLIENT_SECRET', 'ALFA_OAUTH_TOKEN_URL']
  afterEach(() => KEYS.forEach(k => Reflect.deleteProperty(process.env, k)))

  it('returns null when any part is unset', () => {
    expect(bankCredsFromEnv('alfa-by')).toBeNull()
    process.env.ALFA_OAUTH_CLIENT_ID = 'cid'
    expect(bankCredsFromEnv('alfa-by')).toBeNull() // secret/url still missing
  })
  it('resolves alfa creds from ALFA_OAUTH_* when all set', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'cid'
    process.env.ALFA_OAUTH_CLIENT_SECRET = 'sec'
    process.env.ALFA_OAUTH_TOKEN_URL = 'https://bank/token'
    expect(bankCredsFromEnv('alfa-by')).toEqual({ clientId: 'cid', clientSecret: 'sec', tokenUrl: 'https://bank/token' })
  })
  it('manual provider → null (no online OAuth)', () => {
    expect(bankCredsFromEnv('manual')).toBeNull()
  })
})
