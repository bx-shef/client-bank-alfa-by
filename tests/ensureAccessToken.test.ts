import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureAccessToken, needsRefresh, type RefreshDeps } from '../server/utils/ensureAccessToken'
import type { PortalToken, QueryFn } from '../server/utils/tokenStore'

const NOW = 1_700_000_000_000
const FAR = NOW + 3_600_000 // ~1h out → not near expiry
const NEAR = NOW + 10_000 // within the 60s skew → needs refresh

function tok(over: Partial<PortalToken> = {}): PortalToken {
  return { memberId: 'M', domain: 'p.bitrix24.by', accessToken: 'A', refreshToken: 'R', expiresAt: FAR, applicationToken: 'T', ...over }
}

/** Fake deps: pass-through lock, in-memory store, controllable refresh response. */
function make(stored: PortalToken | null, refreshResp: unknown = { access_token: 'A2', refresh_token: 'R2', expires_in: 3600, client_endpoint: 'https://new.bitrix24.by/rest/' }) {
  const store: { current: PortalToken | null } = { current: stored }
  const q = (async () => []) as unknown as QueryFn
  const postRefresh = vi.fn(async () => refreshResp)
  const saveToken = vi.fn(async (_q: QueryFn, t: PortalToken) => {
    store.current = t
  })
  const loadToken = vi.fn(async () => store.current)
  const withLock = vi.fn(async <T>(_k: string, fn: (qq: QueryFn) => Promise<T>) => fn(q))
  const deps: RefreshDeps = { now: () => NOW, withLock, loadToken, saveToken, postRefresh }
  return { deps, store, postRefresh, saveToken, loadToken, withLock }
}

describe('needsRefresh', () => {
  it('true within the skew, false comfortably before expiry', () => {
    expect(needsRefresh(tok({ expiresAt: NEAR }), NOW)).toBe(true)
    expect(needsRefresh(tok({ expiresAt: FAR }), NOW)).toBe(false)
    expect(needsRefresh(tok({ expiresAt: NOW - 1 }), NOW)).toBe(true) // already expired
  })
  it('is inclusive exactly at now+skew, false one ms past (the <= boundary)', () => {
    expect(needsRefresh(tok({ expiresAt: NOW + 60_000 }), NOW)).toBe(true) // == now + default skew
    expect(needsRefresh(tok({ expiresAt: NOW + 60_001 }), NOW)).toBe(false) // one ms outside
  })
})

describe('ensureAccessToken', () => {
  beforeEach(() => {
    process.env.B24_CLIENT_ID = 'cid'
    process.env.B24_CLIENT_SECRET = 'csecret'
  })
  afterEach(() => {
    delete process.env.B24_CLIENT_ID
    delete process.env.B24_CLIENT_SECRET
  })

  it('returns the token untouched when not near expiry (no lock, no refresh)', async () => {
    const { deps, withLock, postRefresh } = make(tok())
    const out = await ensureAccessToken(tok(), deps)
    expect(out.accessToken).toBe('A')
    expect(withLock).not.toHaveBeenCalled()
    expect(postRefresh).not.toHaveBeenCalled()
  })

  it('cannot refresh without client creds — returns the stored token as-is', async () => {
    delete process.env.B24_CLIENT_ID
    const { deps, withLock } = make(tok({ expiresAt: NEAR }))
    const out = await ensureAccessToken(tok({ expiresAt: NEAR }), deps)
    expect(out.accessToken).toBe('A')
    expect(withLock).not.toHaveBeenCalled()
  })

  it('refreshes under the lock and persists the rotated tokens', async () => {
    const near = tok({ expiresAt: NEAR })
    const { deps, postRefresh, saveToken, withLock } = make(near)
    const out = await ensureAccessToken(near, deps)
    expect(withLock).toHaveBeenCalledWith('b24refresh:M', expect.any(Function))
    expect(postRefresh).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ accessToken: 'A2', refreshToken: 'R2', expiresAt: NOW + 3_600_000, domain: 'new.bitrix24.by' })
    expect(saveToken).toHaveBeenCalledTimes(1)
  })

  it('skips the refresh when a concurrent worker already refreshed (re-read inside lock)', async () => {
    // We were asked to refresh a near-expiry token, but the store now holds a fresh one.
    const winner = tok({ accessToken: 'WINNER', expiresAt: FAR })
    const { deps, postRefresh, saveToken } = make(winner)
    const out = await ensureAccessToken(tok({ expiresAt: NEAR }), deps)
    expect(out.accessToken).toBe('WINNER')
    expect(postRefresh).not.toHaveBeenCalled()
    expect(saveToken).not.toHaveBeenCalled()
  })

  it('keeps the old refresh token and domain when the response omits them', async () => {
    const near = tok({ expiresAt: NEAR })
    const { deps } = make(near, { access_token: 'A2', expires_in: 3600 })
    const out = await ensureAccessToken(near, deps)
    expect(out.accessToken).toBe('A2')
    expect(out.refreshToken).toBe('R') // unchanged
    expect(out.domain).toBe('p.bitrix24.by') // no client_endpoint → keep stored domain
  })

  it('does not resurrect a portal uninstalled while we waited for the lock', async () => {
    // The row was deleted between the pre-lock check and the in-lock re-read.
    const { deps, postRefresh, saveToken } = make(null)
    const out = await ensureAccessToken(tok({ expiresAt: NEAR }), deps)
    expect(out.accessToken).toBe('A') // returns the passed token as-is
    expect(postRefresh).not.toHaveBeenCalled()
    expect(saveToken).not.toHaveBeenCalled() // no upsert → no resurrection
  })

  it('throws on a failed refresh (e.g. dead/invalid refresh token)', async () => {
    const near = tok({ expiresAt: NEAR })
    const { deps } = make(near, { error: 'invalid_grant' })
    await expect(ensureAccessToken(near, deps)).rejects.toThrow(/refresh failed: invalid_grant/)
  })
})
