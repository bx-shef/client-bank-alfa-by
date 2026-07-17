import { Buffer } from 'node:buffer'
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

/** Deps that run `fn` immediately (no real lock), with a mutable stored token. Records the
 *  postRefresh + loadToken args so the wiring (right url/body/headers, key parts) is checked. */
function fakeDeps(over: Partial<BankRefreshDeps> & { stored?: BankToken | null, refreshRaw?: unknown } = {}) {
  const saved: BankToken[] = []
  const posts: { url: string, body: string, headers: Record<string, string> }[] = []
  const loads: unknown[][] = []
  const deps: BankRefreshDeps = {
    now: () => NOW,
    withLock: async (_key, fn) => fn((async () => []) as never),
    loadToken: async (_q, m, p, a) => {
      loads.push([m, p, a])
      return over.stored === undefined ? tok() : over.stored
    },
    saveToken: async (_q, t) => { saved.push(t) },
    creds: () => creds,
    postRefresh: async (url, body, headers) => {
      posts.push({ url, body, headers })
      return over.refreshRaw ?? { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 }
    },
    ...over
  }
  return { deps, saved, posts, loads }
}

describe('needsBankRefresh', () => {
  it('true within skew of expiry, false when comfortably fresh', () => {
    expect(needsBankRefresh(tok({ expiresAt: NOW + 30_000 }), NOW)).toBe(true) // 30s < 60s skew
    expect(needsBankRefresh(tok({ expiresAt: NOW + 3_600_000 }), NOW)).toBe(false)
    expect(needsBankRefresh(tok({ expiresAt: NOW - 1 }), NOW)).toBe(true) // already expired
  })
  it('honours the <= skew boundary exactly (default 60s) and an explicit skew', () => {
    expect(needsBankRefresh(tok({ expiresAt: NOW + 60_000 }), NOW)).toBe(true) // == skew edge → refresh
    expect(needsBankRefresh(tok({ expiresAt: NOW + 60_001 }), NOW)).toBe(false) // just past → fresh
    expect(needsBankRefresh(tok({ expiresAt: NOW + 5_000 }), NOW, 1_000)).toBe(false) // explicit 1s skew
  })
})

describe('bankRefreshRequest', () => {
  it('alfa: body carries client_id + client_secret + refresh_token, NO auth header', () => {
    const { url, body, headers } = bankRefreshRequest('alfa-by', creds, 'R')
    expect(url).toBe('https://bank/token')
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=R')
    expect(body).toContain('client_id=cid')
    expect(body).toContain('client_secret=sec')
    expect(headers).toEqual({}) // alfa auths in the body
  })
  it('prior: body is grant_type + refresh_token AND a Basic auth header (client_secret_basic)', () => {
    const { body, headers } = bankRefreshRequest('prior-by', creds, 'R')
    expect(body).toBe('grant_type=refresh_token&refresh_token=R') // secret NOT in body
    // Authorization: Basic base64('cid:sec') — the client auth Prior's token endpoint requires
    expect(headers.authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`)
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
  it('alfa: throws when access_token is missing (delegated to the provider parser)', () => {
    expect(() => parseBankRefresh('alfa-by', { refresh_token: 'R2', expires_in: 3600 })).toThrow(/missing access_token/)
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

  it('locks per (member, provider, account) and loads by the same key parts', async () => {
    const near = tok({ expiresAt: NOW + 10_000 })
    const withLock = vi.fn(async (_key: string, fn: (q: never) => Promise<unknown>) => fn(null as never))
    const { deps, loads } = fakeDeps({ stored: near })
    await ensureBankToken(near, { ...deps, withLock })
    expect(withLock.mock.calls[0]![0]).toBe('bankrefresh:m1:alfa-by:MC_7')
    expect(loads[0]).toEqual(['m1', 'alfa-by', 'MC_7']) // loadToken got the right key parts
  })

  it('NON-FORCE re-read: passed token near-expiry but stored is FRESH (concurrent worker won) → return stored, no refresh', async () => {
    const passedNear = tok({ expiresAt: NOW + 10_000, accessToken: 'OLD' })
    const storedFresh = tok({ expiresAt: NOW + 3_600_000, accessToken: 'FRESH' })
    const { deps, saved, posts } = fakeDeps({ stored: storedFresh })
    const out = await ensureBankToken(passedNear, deps)
    expect(out).toBe(storedFresh) // used the concurrent worker's fresh token
    expect(posts).toHaveLength(0) // no refresh POST
    expect(saved).toHaveLength(0) // nothing persisted
  })

  it('sends the RIGHT url/body/headers to postRefresh (wiring: uses stored.refreshToken + provider request)', async () => {
    const near = tok({ provider: 'prior-by', expiresAt: NOW + 10_000, refreshToken: 'STORED_R' })
    const { deps, posts } = fakeDeps({ stored: near, refreshRaw: { access_token: 'A2', expires_in: 900 } })
    await ensureBankToken(near, deps)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe('https://bank/token')
    expect(posts[0]!.body).toBe('grant_type=refresh_token&refresh_token=STORED_R') // stored refresh, not the passed one
    expect(posts[0]!.headers.authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`) // Prior Basic auth reaches the POST
  })

  it('force on a clock-fresh already-rotated token persists nothing', async () => {
    const rotated = tok({ accessToken: 'ROTATED' })
    const { deps, saved } = fakeDeps({ stored: rotated })
    await ensureBankToken(tok({ accessToken: 'OLD' }), deps, { force: true })
    expect(saved).toHaveLength(0)
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
  it('resolves prior creds from PRIOR_OAUTH_* (separate prefix)', () => {
    const PK = ['PRIOR_OAUTH_CLIENT_ID', 'PRIOR_OAUTH_CLIENT_SECRET', 'PRIOR_OAUTH_TOKEN_URL']
    process.env.PRIOR_OAUTH_CLIENT_ID = 'pid'
    process.env.PRIOR_OAUTH_CLIENT_SECRET = 'psec'
    process.env.PRIOR_OAUTH_TOKEN_URL = 'https://prior/token'
    try {
      expect(bankCredsFromEnv('prior-by')).toEqual({ clientId: 'pid', clientSecret: 'psec', tokenUrl: 'https://prior/token' })
      expect(bankCredsFromEnv('alfa-by')).toBeNull() // alfa prefix not set → isolated
    } finally {
      PK.forEach(k => Reflect.deleteProperty(process.env, k))
    }
  })
  it('manual provider → null (no online OAuth)', () => {
    expect(bankCredsFromEnv('manual')).toBeNull()
  })
})
