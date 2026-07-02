import { describe, expect, it, vi } from 'vitest'
import { processB24Event } from '../server/utils/b24EventsHandler'
import type { B24EventDeps } from '../server/utils/b24EventsHandler'

const APP_TOKEN = '51856fefc120afa4b628cc82d3935cce'

// The handler now VERIFIES only (reads), never writes — deps are reads only.
function makeDeps(over: Partial<B24EventDeps> = {}): B24EventDeps {
  return {
    envToken: '',
    loadStoredToken: vi.fn(async () => ''),
    ...over
  }
}

const install = {
  event: 'ONAPPINSTALL',
  data: { VERSION: '1', INSTALLED: 'Y', LANGUAGE_ID: 'ru' },
  auth: {
    domain: 'p.bitrix24.ru',
    member_id: 'm1',
    application_token: APP_TOKEN,
    access_token: 'A',
    refresh_token: 'R',
    expires_in: 3600
  }
}

const uninstall = {
  event: 'ONAPPUNINSTALL',
  data: { LANGUAGE_ID: 'ru', CLEAN: 1 },
  auth: { domain: 'p.bitrix24.ru', member_id: 'm1', application_token: APP_TOKEN }
}

describe('processB24Event — install', () => {
  it('returns 200 with a register action carrying the credentials (bootstrap, no env token)', async () => {
    const res = await processB24Event(install, makeDeps())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, event: 'ONAPPINSTALL', memberId: 'm1' })
    expect(res.action).toMatchObject({
      type: 'register',
      memberId: 'm1',
      credentials: expect.objectContaining({ memberId: 'm1', applicationToken: APP_TOKEN, accessToken: 'A', refreshToken: 'R' })
    })
  })

  it('accepts install when the env token matches', async () => {
    const res = await processB24Event(install, makeDeps({ envToken: APP_TOKEN }))
    expect(res.status).toBe(200)
    expect(res.action?.type).toBe('register')
  })

  it('returns 403 with no action when the env token mismatches', async () => {
    const res = await processB24Event(install, makeDeps({ envToken: 'different' }))
    expect(res.status).toBe(403)
    expect(res.action).toBeUndefined()
  })

  it('returns 400 on a malformed install', async () => {
    const bad = { event: 'ONAPPINSTALL', data: {}, auth: { domain: 'd' } }
    const res = await processB24Event(bad, makeDeps())
    expect(res.status).toBe(400)
    expect(res.action).toBeUndefined()
  })

  it('rejects an install with an empty token (probe) with no action', async () => {
    const empty = { ...install, auth: { ...install.auth, application_token: '' } }
    const res = await processB24Event(empty, makeDeps())
    // Empty token → parse fails (auth incomplete) → 400; no action.
    expect(res.status).toBe(400)
    expect(res.action).toBeUndefined()
  })

  it('never echoes a token in the 403 body', async () => {
    const res = await processB24Event(install, makeDeps({ envToken: 'secret-env-token' }))
    expect(res.status).toBe(403)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('secret-env-token')
    expect(body).not.toContain(APP_TOKEN)
  })
})

describe('processB24Event — uninstall (always unregisters)', () => {
  it('returns an unregister action when the stored token matches', async () => {
    const res = await processB24Event(uninstall, makeDeps({ loadStoredToken: vi.fn(async () => APP_TOKEN) }))
    expect(res.status).toBe(200)
    expect(res.action).toEqual({ type: 'unregister', memberId: 'm1' })
  })

  it('unregisters even when CLEAN=0 (policy: a removed app keeps no data)', async () => {
    const keep = { ...uninstall, data: { LANGUAGE_ID: 'ru', CLEAN: 0 } }
    const res = await processB24Event(keep, makeDeps({ loadStoredToken: vi.fn(async () => APP_TOKEN) }))
    expect(res.status).toBe(200)
    expect(res.action).toEqual({ type: 'unregister', memberId: 'm1' })
  })

  it('returns 503 (fail-closed) with no action when no stored or env token', async () => {
    const res = await processB24Event(uninstall, makeDeps())
    expect(res.status).toBe(503)
    expect(res.action).toBeUndefined()
  })

  it('returns 400 on a malformed uninstall (missing member_id), no action', async () => {
    const bad = { event: 'ONAPPUNINSTALL', data: { CLEAN: 1 }, auth: { domain: 'd' } }
    const res = await processB24Event(bad, makeDeps({ loadStoredToken: vi.fn(async () => APP_TOKEN) }))
    expect(res.status).toBe(400)
    expect(res.action).toBeUndefined()
  })

  it('returns 403 with no action when the stored token mismatches', async () => {
    const res = await processB24Event(uninstall, makeDeps({ loadStoredToken: vi.fn(async () => 'other') }))
    expect(res.status).toBe(403)
    expect(res.action).toBeUndefined()
  })

  it('accepts via env token even when the portal is unknown', async () => {
    const res = await processB24Event(uninstall, makeDeps({ envToken: APP_TOKEN }))
    expect(res.status).toBe(200)
    expect(res.action).toEqual({ type: 'unregister', memberId: 'm1' })
  })
})

describe('processB24Event — other', () => {
  it('acknowledges unsubscribed events with 200 and no action', async () => {
    const res = await processB24Event({ event: 'ONCRMDEALADD', auth: {} }, makeDeps())
    expect(res).toEqual({ status: 200, body: { ok: true, ignored: 'ONCRMDEALADD' } })
  })
})
