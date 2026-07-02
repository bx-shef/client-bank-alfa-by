import { describe, expect, it, vi } from 'vitest'
import { makePortalRestCall, type PortalRestDeps } from '../server/utils/portalRest'
import type { PortalToken } from '../server/utils/tokenStore'

function tok(over: Partial<PortalToken> = {}): PortalToken {
  return {
    memberId: 'm1', domain: 'p.bitrix24.by', accessToken: 'AT', refreshToken: 'RT',
    expiresAt: 2_000_000_000_000, applicationToken: 'x', ...over
  }
}

describe('makePortalRestCall', () => {
  it('returns null when the portal has no token (skip cleanly)', async () => {
    const deps: PortalRestDeps = {
      loadToken: async () => null,
      ensureFresh: async t => t,
      callRest: vi.fn(async () => ({}))
    }
    expect(await makePortalRestCall('m1', deps)).toBeNull()
    expect(deps.callRest).not.toHaveBeenCalled()
  })

  it('binds callRest to the refreshed token host + access token', async () => {
    // Distinct domains for stale vs refreshed so the assertion pins that BOTH the
    // host and access token come from the post-refresh token, not the stale one.
    const refreshed = tok({ accessToken: 'FRESH', domain: 'new.bitrix24.by' })
    const callRest = vi.fn(async () => ({ result: [] }))
    const deps: PortalRestDeps = {
      loadToken: async () => tok({ accessToken: 'STALE', domain: 'old.bitrix24.by' }),
      ensureFresh: async () => refreshed,
      callRest
    }
    const call = await makePortalRestCall('m1', deps)
    expect(call).toBeTypeOf('function')
    await call!('crm.requisite.list', { filter: { ID: 1 } })
    // Uses the FRESH access token + the FRESH domain, not the stale ones.
    expect(callRest).toHaveBeenCalledWith('new.bitrix24.by', 'FRESH', 'crm.requisite.list', { filter: { ID: 1 } })
  })

  it('refreshes via ensureFresh before binding', async () => {
    const ensureFresh = vi.fn(async (t: PortalToken) => ({ ...t, accessToken: 'NEW' }))
    const deps: PortalRestDeps = {
      loadToken: async () => tok(),
      ensureFresh,
      callRest: async () => ({})
    }
    await makePortalRestCall('m1', deps)
    expect(ensureFresh).toHaveBeenCalledOnce()
  })
})
