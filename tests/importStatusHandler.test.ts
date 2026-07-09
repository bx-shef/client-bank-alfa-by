import { describe, expect, it, vi } from 'vitest'
import type { ImportRunSummary } from '../app/types/importStatus'
import { emptyImportSummary } from '../app/utils/importStatus'
import { handleImportStatus, type ImportStatusDeps } from '../server/utils/importStatusHandler'

const sample: ImportRunSummary = {
  state: 'ok', lastSyncAt: '2026-07-09T08:00:00.000Z', operations: 5,
  activitiesCreated: 3, chatNotified: 2, errors: []
}

function deps(over: Partial<ImportStatusDeps> = {}): ImportStatusDeps {
  return {
    memberIdByDomain: async () => 'M',
    validateFrame: async () => 'user-7',
    getResult: async () => sample,
    ...over
  }
}

describe('handleImportStatus', () => {
  it('401 when token or domain missing', async () => {
    expect((await handleImportStatus(deps(), { accessToken: '', domain: 'd' })).status).toBe(401)
    expect((await handleImportStatus(deps(), { accessToken: 't', domain: '' })).status).toBe(401)
  })

  it('409 when the portal is not installed (no member for the domain)', async () => {
    const d = deps({ memberIdByDomain: async () => null })
    expect((await handleImportStatus(d, { accessToken: 't', domain: 'd' })).status).toBe(409)
  })

  it('403 when the frame token is invalid / foreign (validateFrame throws or empty)', async () => {
    const boom: ImportStatusDeps['validateFrame'] = async () => {
      throw new Error('AUTH')
    }
    const thrown = deps({ validateFrame: boom })
    expect((await handleImportStatus(thrown, { accessToken: 't', domain: 'd' })).status).toBe(403)
    const empty = deps({ validateFrame: async () => '' })
    expect((await handleImportStatus(empty, { accessToken: 't', domain: 'd' })).status).toBe(403)
  })

  it('200 with the stored summary for a valid frame request', async () => {
    const r = await handleImportStatus(deps(), { accessToken: 't', domain: 'd' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual(sample)
  })

  it('200 with the never-summary when the portal has no recorded run', async () => {
    const r = await handleImportStatus(deps({ getResult: async () => null }), { accessToken: 't', domain: 'd' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual(emptyImportSummary())
  })

  it('does not validate the token before resolving the portal (order: domain → token)', async () => {
    const validateFrame = vi.fn(async () => 'user-7')
    const d = deps({ memberIdByDomain: async () => null, validateFrame })
    await handleImportStatus(d, { accessToken: 't', domain: 'd' })
    expect(validateFrame).not.toHaveBeenCalled() // 409 short-circuits before the profile call
  })
})
