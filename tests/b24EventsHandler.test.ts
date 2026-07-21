import { describe, expect, it, vi } from 'vitest'
import { handleEventRequest, processB24Event } from '../server/utils/b24EventsHandler'
import type { B24EventDeps, B24RequestDeps } from '../server/utils/b24EventsHandler'

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

const NOW = 1_000_000
function makeReqDeps(over: Partial<B24RequestDeps> = {}): B24RequestDeps {
  return {
    envToken: '',
    loadStoredToken: vi.fn(async () => APP_TOKEN),
    enqueue: vi.fn(async () => true),
    enqueueDeletion: vi.fn(async () => true),
    saveCredentials: vi.fn(async () => {}),
    deletePortal: vi.fn(async () => {}),
    encrypt: vi.fn((s: string) => `enc(${s})`),
    now: () => NOW,
    ...over
  }
}

const dealDelete = {
  event: 'ONCRMDEALDELETE',
  data: { FIELDS: { ID: '15' } },
  auth: { domain: 'p.bitrix24.ru', member_id: 'm1', application_token: APP_TOKEN },
  ts: '1700000000'
}
const dynamicDelete = {
  event: 'ONCRMDYNAMICITEMDELETE',
  data: { FIELDS: { ID: '39', ENTITY_TYPE_ID: '31' } },
  auth: { domain: 'p.bitrix24.ru', member_id: 'm1', application_token: APP_TOKEN },
  ts: '1700000001'
}

describe('processB24Event — CRM deletion (§9.2)', () => {
  it('verified deal deletion → reconcile-deletion action with raw fields', async () => {
    const res = await processB24Event(dealDelete, makeDeps({ loadStoredToken: vi.fn(async () => APP_TOKEN) }))
    expect(res.status).toBe(200)
    expect(res.action).toMatchObject({
      type: 'reconcile-deletion',
      memberId: 'm1',
      deletion: { eventCode: 'ONCRMDEALDELETE', entityId: '15' }
    })
  })

  it('dynamic-item deletion carries the raw entityTypeId (classification deferred to consumer)', async () => {
    const res = await processB24Event(dynamicDelete, makeDeps({ loadStoredToken: vi.fn(async () => APP_TOKEN) }))
    expect(res.action).toMatchObject({ type: 'reconcile-deletion', deletion: { entityTypeId: 31, entityId: '39' } })
  })

  it('rejects a deletion with a bad application_token (fail-closed, no action)', async () => {
    const res = await processB24Event(dealDelete, makeDeps({ envToken: 'different', loadStoredToken: vi.fn(async () => 'different') }))
    expect(res.status).toBe(403)
    expect(res.action).toBeUndefined()
  })

  it('acks (no action) a verified deletion with no usable id', async () => {
    const noId = { ...dealDelete, data: { FIELDS: {} } }
    const res = await processB24Event(noId, makeDeps({ loadStoredToken: vi.fn(async () => APP_TOKEN) }))
    expect(res.status).toBe(200)
    expect(res.action).toBeUndefined()
  })
})

describe('handleEventRequest — primary (enqueue) path', () => {
  it('enqueues a register job (refresh ENCRYPTED, access clear) and does NOT write synchronously', async () => {
    const deps = makeReqDeps()
    const res = await handleEventRequest(install, deps)
    expect(res.outcome).toBe('queued')
    expect(res.status).toBe(200)
    expect(deps.saveCredentials).not.toHaveBeenCalled()
    const job = (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(job).toMatchObject({ memberId: 'm1', kind: 'ONAPPINSTALL' })
    // refresh is encrypted in the job; access token stays clear.
    expect(job.credentials.refreshTokenEnc).toBe('enc(R)')
    expect(job.credentials.accessToken).toBe('A')
    expect(deps.encrypt).toHaveBeenCalledWith('R')
    // expiresAt stamped from injected now + 3600s.
    expect(job.credentials.expiresAt).toBe(NOW + 3600 * 1000)
  })

  it('#162: binds member_id, then enqueues the ROTATED grant (delivered refresh_token replaced)', async () => {
    const bindInstallMember = vi.fn(async () => ({
      ok: true,
      grant: { accessToken: 'A2', refreshToken: 'R2', clientEndpoint: 'https://p.bitrix24.ru/rest/', expiresIn: 7200 }
    }))
    const deps = makeReqDeps({ bindInstallMember })
    const res = await handleEventRequest(install, deps)
    expect(res.outcome).toBe('queued')
    // bound with the DELIVERED refresh_token ('R'), before persisting anything.
    expect(bindInstallMember).toHaveBeenCalledWith('m1', 'R')
    const job = (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    // The ROTATED grant is stored — the spent delivered token ('R') must NOT be persisted.
    expect(job.credentials.accessToken).toBe('A2')
    expect(job.credentials.refreshTokenEnc).toBe('enc(R2)')
    expect(deps.encrypt).toHaveBeenCalledWith('R2')
    expect(deps.encrypt).not.toHaveBeenCalledWith('R')
    // expiresAt uses the grant's expires_in (7200), not the delivered 3600.
    expect(job.credentials.expiresAt).toBe(NOW + 7200 * 1000)
  })

  it('#162: a spoofed install (bind → 403) is NOT persisted (no enqueue, no sync write)', async () => {
    const bindInstallMember = vi.fn(async () => ({ ok: false as const, status: 403 as const }))
    const deps = makeReqDeps({ bindInstallMember })
    const res = await handleEventRequest(install, deps)
    expect(res.status).toBe(403)
    expect(res.outcome).toBe('none')
    expect(deps.enqueue).not.toHaveBeenCalled()
    expect(deps.saveCredentials).not.toHaveBeenCalled()
  })

  it('#162: a transient bind failure (503) is NOT persisted (fail-closed)', async () => {
    const deps = makeReqDeps({ bindInstallMember: vi.fn(async () => ({ ok: false as const, status: 503 as const })) })
    const res = await handleEventRequest(install, deps)
    expect(res.status).toBe(503)
    expect(res.outcome).toBe('none')
    expect(deps.enqueue).not.toHaveBeenCalled()
    expect(deps.saveCredentials).not.toHaveBeenCalled()
  })

  it('#162: uninstall is unaffected by the bind dep (only register binds)', async () => {
    const bindInstallMember = vi.fn(async () => ({ ok: true }))
    const deps = makeReqDeps({ bindInstallMember })
    await handleEventRequest(uninstall, deps)
    expect(bindInstallMember).not.toHaveBeenCalled()
  })

  it('#162: with no bind dep wired (no OAuth creds) install persists unchanged (degraded)', async () => {
    const deps = makeReqDeps() // bindInstallMember undefined
    const res = await handleEventRequest(install, deps)
    expect(res.outcome).toBe('queued')
    const job = (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(job.credentials.refreshTokenEnc).toBe('enc(R)') // delivered creds, as before
  })

  it('enqueues an unregister job (no credentials) on uninstall', async () => {
    const deps = makeReqDeps()
    const res = await handleEventRequest(uninstall, deps)
    expect(res.outcome).toBe('queued')
    const job = (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(job).toMatchObject({ memberId: 'm1', kind: 'ONAPPUNINSTALL' })
    expect(job.credentials).toBeUndefined()
    expect(deps.deletePortal).not.toHaveBeenCalled()
  })

  it('enqueues a deletion job (no sync fallback) on a verified deletion event', async () => {
    const deps = makeReqDeps()
    const res = await handleEventRequest(dealDelete, deps)
    expect(res.outcome).toBe('queued')
    expect(res.status).toBe(200)
    const job = (deps.enqueueDeletion as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(job).toMatchObject({ memberId: 'm1', eventCode: 'ONCRMDEALDELETE', entityId: '15', domain: 'p.bitrix24.ru', ts: '1700000000' })
    // deletions never take the install/uninstall sync-write path
    expect(deps.saveCredentials).not.toHaveBeenCalled()
    expect(deps.deletePortal).not.toHaveBeenCalled()
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('deletion with queue DOWN → outcome none (recoverable via «пересчитать»), no sync fallback', async () => {
    const deps = makeReqDeps({ enqueueDeletion: vi.fn(async () => false) })
    const res = await handleEventRequest(dealDelete, deps)
    expect(res.outcome).toBe('none')
    expect(res.status).toBe(200)
    expect(deps.deletePortal).not.toHaveBeenCalled()
  })

  it('deletion with a throwing enqueue → still ACKs (outcome none), never throws', async () => {
    const throwingEnqueue = async (): Promise<never> => {
      throw new Error('redis down')
    }
    const deps = makeReqDeps({ enqueueDeletion: vi.fn(throwingEnqueue) })
    const res = await handleEventRequest(dealDelete, deps)
    expect(res.outcome).toBe('none')
    expect(res.status).toBe(200)
  })

  it('does nothing (outcome none) and never enqueues on a denied event', async () => {
    const deps = makeReqDeps({ envToken: 'different' })
    const res = await handleEventRequest(install, deps)
    expect(res.status).toBe(403)
    expect(res.outcome).toBe('none')
    expect(deps.enqueue).not.toHaveBeenCalled()
    expect(deps.saveCredentials).not.toHaveBeenCalled()
  })
})

describe('handleEventRequest — synchronous fallback (queue unavailable)', () => {
  it('writes credentials synchronously when the queue is disabled (enqueue → false)', async () => {
    const deps = makeReqDeps({ enqueue: vi.fn(async () => false) })
    const res = await handleEventRequest(install, deps)
    expect(res.outcome).toBe('sync-fallback')
    expect(res.status).toBe(200)
    // saveToken encrypts internally → pass RAW refresh here (not the enc blob).
    expect(deps.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'm1', accessToken: 'A', refreshToken: 'R', applicationToken: APP_TOKEN, expiresAt: NOW + 3600 * 1000
    }), 0) // eventTs 0 (fixture carries no ts) — ordering guard (#77)
  })

  it('writes synchronously when enqueue THROWS (Redis down)', async () => {
    const boom = vi.fn(async () => Promise.reject(new Error('ECONNREFUSED')))
    const deps = makeReqDeps({ enqueue: boom })
    const res = await handleEventRequest(install, deps)
    expect(res.outcome).toBe('sync-fallback')
    expect(deps.saveCredentials).toHaveBeenCalled()
  })

  it('deletes the portal synchronously on uninstall when the queue is disabled', async () => {
    const deps = makeReqDeps({ enqueue: vi.fn(async () => false) })
    const res = await handleEventRequest(uninstall, deps)
    expect(res.outcome).toBe('sync-fallback')
    expect(deps.deletePortal).toHaveBeenCalledWith('m1', 0) // eventTs 0 (no ts) — ordering guard (#77)
  })
})

describe('handleEventRequest — expiresAt/TTL coercion', () => {
  const enc = (s: string) => s
  async function jobFor(expires_in: unknown) {
    const deps = makeReqDeps({ encrypt: enc })
    const payload = { ...install, auth: { ...install.auth, expires_in } }
    await handleEventRequest(payload, deps)
    return (deps.enqueue as ReturnType<typeof vi.fn>).mock.calls[0]![0]
  }
  it('defaults a missing expires_in to 3600s', async () => {
    const job = await jobFor(undefined)
    expect(job.credentials.expiresAt).toBe(NOW + 3600 * 1000)
  })
  it('honours an explicit 0 (already expired)', async () => {
    const job = await jobFor(0)
    expect(job.credentials.expiresAt).toBe(NOW)
  })
  it('falls back to 3600s for a non-finite value', async () => {
    const job = await jobFor('abc')
    expect(job.credentials.expiresAt).toBe(NOW + 3600 * 1000)
  })
})
