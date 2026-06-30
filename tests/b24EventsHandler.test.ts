import { describe, expect, it, vi } from 'vitest'
import { processB24Event } from '../server/utils/b24EventsHandler'
import type { B24EventDeps } from '../server/utils/b24EventsHandler'

const APP_TOKEN = '51856fefc120afa4b628cc82d3935cce'

function makeDeps(over: Partial<B24EventDeps> = {}): B24EventDeps {
  return {
    envToken: '',
    loadStoredToken: vi.fn(async () => ''),
    saveCredentials: vi.fn(async () => {}),
    deletePortal: vi.fn(async () => {}),
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
  it('persists credentials and returns 200 (bootstrap, no env token)', async () => {
    const deps = makeDeps()
    const res = await processB24Event(install, deps)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, event: 'ONAPPINSTALL', memberId: 'm1' })
    expect(deps.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'm1', applicationToken: APP_TOKEN, accessToken: 'A', refreshToken: 'R'
    }))
  })

  it('accepts install when the env token matches', async () => {
    const deps = makeDeps({ envToken: APP_TOKEN })
    expect((await processB24Event(install, deps)).status).toBe(200)
  })

  it('returns 403 and does not persist when the env token mismatches', async () => {
    const deps = makeDeps({ envToken: 'different' })
    const res = await processB24Event(install, deps)
    expect(res.status).toBe(403)
    expect(deps.saveCredentials).not.toHaveBeenCalled()
  })

  it('returns 400 on a malformed install', async () => {
    const bad = { event: 'ONAPPINSTALL', data: {}, auth: { domain: 'd' } }
    const res = await processB24Event(bad, makeDeps())
    expect(res.status).toBe(400)
  })
})

describe('processB24Event — uninstall', () => {
  it('purges and returns 200 when the stored token matches and CLEAN=1', async () => {
    const deps = makeDeps({ loadStoredToken: vi.fn(async () => APP_TOKEN) })
    const res = await processB24Event(uninstall, deps)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, purged: true })
    expect(deps.deletePortal).toHaveBeenCalledWith('m1')
  })

  it('does not purge when CLEAN=0', async () => {
    const deps = makeDeps({ loadStoredToken: vi.fn(async () => APP_TOKEN) })
    const keep = { ...uninstall, data: { LANGUAGE_ID: 'ru', CLEAN: 0 } }
    const res = await processB24Event(keep, deps)
    expect(res.body).toMatchObject({ purged: false })
    expect(deps.deletePortal).not.toHaveBeenCalled()
  })

  it('returns 503 (fail-closed) when no stored or env token', async () => {
    const deps = makeDeps()
    const res = await processB24Event(uninstall, deps)
    expect(res.status).toBe(503)
    expect(deps.deletePortal).not.toHaveBeenCalled()
  })

  it('returns 403 when the stored token mismatches', async () => {
    const deps = makeDeps({ loadStoredToken: vi.fn(async () => 'other') })
    const res = await processB24Event(uninstall, deps)
    expect(res.status).toBe(403)
    expect(deps.deletePortal).not.toHaveBeenCalled()
  })

  it('accepts via env token even when the portal is unknown', async () => {
    const deps = makeDeps({ envToken: APP_TOKEN })
    const res = await processB24Event(uninstall, deps)
    expect(res.status).toBe(200)
    expect(deps.deletePortal).toHaveBeenCalledWith('m1')
  })
})

describe('processB24Event — other', () => {
  it('acknowledges unsubscribed events with 200', async () => {
    const res = await processB24Event({ event: 'ONCRMDEALADD', auth: {} }, makeDeps())
    expect(res).toEqual({ status: 200, body: { ok: true, ignored: 'ONCRMDEALADD' } })
  })
})
