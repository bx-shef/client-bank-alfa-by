import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bankConnectConfigFromEnv,
  handleBankConnectStart,
  CONNECT_STATE_TTL_MS,
  type ConnectStartDeps
} from '../server/utils/bankConnectStart'
import { verifyConnectState } from '../server/utils/bankConnectState'
import { parseOAuthCallback } from '../app/utils/alfaOauth'

const SECRET = 'connect-secret'
const now = 1_700_000_000_000

const CONFIG = { baseUrl: 'https://alfa:8273', clientId: 'CID', redirectUri: 'https://app/cb', scope: 'accounts' }

function deps(over: Partial<ConnectStartDeps> = {}): ConnectStartDeps {
  return {
    memberIdByDomain: async () => 'MEMBER1',
    validateFrame: async () => ({ userId: 'USER9', isAdmin: true }),
    config: () => CONFIG,
    secret: SECRET,
    ...over
  }
}

const input = {
  accessToken: 'TKN', domain: 'p.bitrix24.by', provider: 'alfa-by' as const,
  nonce: 'nonce123', nowMs: now
}

describe('bankConnectConfigFromEnv', () => {
  const KEYS = ['ALFA_OAUTH_CLIENT_ID', 'ALFA_OAUTH_TOKEN_URL', 'ALFA_OAUTH_REDIRECT_URI', 'ALFA_OAUTH_SCOPE']
  afterEach(() => KEYS.forEach(k => Reflect.deleteProperty(process.env, k)))

  it('null until client_id + token_url + redirect_uri are all set', () => {
    expect(bankConnectConfigFromEnv('alfa-by')).toBeNull()
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    expect(bankConnectConfigFromEnv('alfa-by')).toBeNull() // still missing token/redirect
    process.env.ALFA_OAUTH_TOKEN_URL = 'https://alfa:8273/token'
    expect(bankConnectConfigFromEnv('alfa-by')).toBeNull() // still missing redirect
    process.env.ALFA_OAUTH_REDIRECT_URI = 'https://app/cb'
    expect(bankConnectConfigFromEnv('alfa-by')).toEqual({ baseUrl: 'https://alfa:8273', clientId: 'CID', redirectUri: 'https://app/cb' })
  })
  it('derives the authorize host by stripping /token; picks up optional scope', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    process.env.ALFA_OAUTH_TOKEN_URL = 'https://alfa:8273/token/'
    process.env.ALFA_OAUTH_REDIRECT_URI = 'https://app/cb'
    process.env.ALFA_OAUTH_SCOPE = 'accounts payments'
    expect(bankConnectConfigFromEnv('alfa-by')).toEqual({
      baseUrl: 'https://alfa:8273', clientId: 'CID', redirectUri: 'https://app/cb', scope: 'accounts payments'
    })
  })
  it('null when TOKEN_URL does not end in /token (cannot derive authorize host)', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    process.env.ALFA_OAUTH_TOKEN_URL = 'https://alfa:8273/oauth2'
    process.env.ALFA_OAUTH_REDIRECT_URI = 'https://app/cb'
    expect(bankConnectConfigFromEnv('alfa-by')).toBeNull()
  })
  it('prior-by / manual → null (Prior connect is A5b; manual has no OAuth)', () => {
    expect(bankConnectConfigFromEnv('prior-by')).toBeNull()
    expect(bankConnectConfigFromEnv('manual')).toBeNull()
  })
})

describe('handleBankConnectStart', () => {
  it('mints an authorize URL carrying a signed state with OUR memberId (not the client)', async () => {
    const r = await handleBankConnectStart(deps(), input)
    expect(r.status).toBe(200)
    const url = new URL(r.body.authorizeUrl as string)
    expect(url.origin + url.pathname).toBe('https://alfa:8273/authorize')
    expect(url.searchParams.get('client_id')).toBe('CID')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb')
    expect(url.searchParams.get('response_type')).toBe('code')
    // The state verifies and carries the resolved memberId + provider (callback can trust it).
    const state = verifyConnectState(url.searchParams.get('state')!, SECRET, now)
    expect(state).toMatchObject({ memberId: 'MEMBER1', provider: 'alfa-by', nonce: 'nonce123' })
    expect(state!.exp).toBe(now + CONNECT_STATE_TTL_MS)
    // parseOAuthCallback (the callback's verifier) accepts this exact state for a matching code.
    expect(parseOAuthCallback({ code: 'C', state: url.searchParams.get('state')! }, url.searchParams.get('state')!)).toEqual({ code: 'C' })
  })

  it('400 without frame auth / provider', async () => {
    expect((await handleBankConnectStart(deps(), { ...input, accessToken: '' })).status).toBe(400)
    expect((await handleBankConnectStart(deps(), { ...input, domain: '' })).status).toBe(400)
    expect((await handleBankConnectStart(deps(), { ...input, provider: '' as 'alfa-by' })).status).toBe(400)
  })

  it('400 when the provider is not configured/supported (no broken URL, no REST)', async () => {
    const validateFrame = vi.fn(async () => ({ userId: 'U', isAdmin: true }))
    const r = await handleBankConnectStart(deps({ config: () => null, validateFrame }), input)
    expect(r.status).toBe(400)
    expect(validateFrame).not.toHaveBeenCalled() // rejected before any REST
  })

  it('503 when no signing secret (fail-closed — callback could never verify)', async () => {
    const r = await handleBankConnectStart(deps({ secret: '' }), input)
    expect(r.status).toBe(503)
  })

  it('409 when the portal is not installed (no key)', async () => {
    const r = await handleBankConnectStart(deps({ memberIdByDomain: async () => null }), input)
    expect(r.status).toBe(409)
  })

  it('403 when the frame token is not valid for this portal (spoofed domain)', async () => {
    const validateFrame = async () => {
      throw new Error('bad token')
    }
    const r = await handleBankConnectStart(deps({ validateFrame }), input)
    expect(r.status).toBe(403)
  })

  it('403 when the initiating user is not a portal admin (bank connect is admin-only)', async () => {
    const r = await handleBankConnectStart(deps({ validateFrame: async () => ({ userId: 'U', isAdmin: false }) }), input)
    expect(r.status).toBe(403)
    expect(String(r.body.error)).toMatch(/administrator/)
  })

  it('503 no-secret is fail-closed BEFORE any REST (no memberIdByDomain/validateFrame call)', async () => {
    const memberIdByDomain = vi.fn(async () => 'MEMBER1')
    const validateFrame = vi.fn(async () => ({ userId: 'U', isAdmin: true }))
    const r = await handleBankConnectStart(deps({ secret: '', memberIdByDomain, validateFrame }), input)
    expect(r.status).toBe(503)
    expect(memberIdByDomain).not.toHaveBeenCalled()
    expect(validateFrame).not.toHaveBeenCalled()
  })

  it('respects a ttlMs override on the state expiry', async () => {
    const r = await handleBankConnectStart(deps(), { ...input, ttlMs: 60_000 })
    const state = verifyConnectState(new URL(r.body.authorizeUrl as string).searchParams.get('state')!, SECRET, now)
    expect(state!.exp).toBe(now + 60_000)
  })
})
