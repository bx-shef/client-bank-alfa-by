import { describe, expect, it, vi } from 'vitest'
import { handleBankConnectCallback, sanitizeForLog, type CallbackDeps } from '../server/utils/bankConnectCallback'
import { signConnectState } from '../server/utils/bankConnectState'
import type { BankToken } from '../server/utils/bankTokenStore'

const SECRET = 'cb-secret'
const now = 1_700_000_000_000
const CONFIG = { baseUrl: 'https://alfa:8273', clientId: 'CID', redirectUri: 'https://app/cb' }

const goodState = signConnectState(
  { memberId: 'M1', provider: 'alfa-by', accountKey: 'BY13ALFA', nonce: 'n1', exp: now + 600_000 },
  SECRET
)

const tokenJson = { access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer', expires_in: 3600 }

function deps(over: Partial<CallbackDeps> & { saved?: BankToken[] } = {}) {
  const saved: BankToken[] = over.saved ?? []
  const d: CallbackDeps = {
    secret: SECRET,
    config: () => CONFIG,
    clientSecret: () => 'CSECRET',
    exchangeToken: async () => tokenJson,
    saveToken: async (t) => {
      saved.push(t)
    },
    log: () => {},
    ...over
  }
  return { deps: d, saved }
}

describe('sanitizeForLog', () => {
  it('strips CR/LF and caps length (provider text cannot forge log lines)', () => {
    expect(sanitizeForLog('a\r\nb\nc')).toBe('a b c')
    expect(sanitizeForLog('x'.repeat(500)).length).toBe(200)
  })
})

describe('handleBankConnectCallback', () => {
  it('happy path: verifies state → exchanges code → saves token under the state account', async () => {
    const { deps: d, saved } = deps()
    const exchangeToken = vi.fn(async () => tokenJson)
    const r = await handleBankConnectCallback({ ...d, exchangeToken }, { query: { code: 'C', state: goodState }, nowMs: now })
    expect(r.status).toBe(200)
    expect(r.html).toContain('подключён')
    expect(exchangeToken).toHaveBeenCalledTimes(1)
    expect(saved).toEqual([{
      memberId: 'M1', provider: 'alfa-by', accountKey: 'BY13ALFA',
      accessToken: 'AT', refreshToken: 'RT', expiresAt: now + 3600 * 1000
    }])
  })

  it('400 + no exchange when the state is missing/invalid/expired', async () => {
    const exchangeToken = vi.fn(async () => tokenJson)
    const bad = ['', 'garbage', signConnectState({ memberId: 'M', provider: 'alfa-by', accountKey: 'A', nonce: 'n', exp: now - 1 }, SECRET)]
    for (const state of bad) {
      const r = await handleBankConnectCallback({ ...deps().deps, exchangeToken }, { query: { code: 'C', state }, nowMs: now })
      expect(r.status).toBe(400)
    }
    expect(exchangeToken).not.toHaveBeenCalled()
  })

  it('400 when the bank returned an error (text NOT rendered; logged sanitized)', async () => {
    const log = vi.fn()
    const exchangeToken = vi.fn(async () => tokenJson)
    const r = await handleBankConnectCallback(
      { ...deps().deps, exchangeToken, log },
      { query: { error: 'access_denied', error_description: 'nope\r\ninjected', state: goodState }, nowMs: now }
    )
    expect(r.status).toBe(400)
    expect(r.html).not.toContain('access_denied') // provider text never on the page
    expect(r.html).not.toContain('injected')
    expect(exchangeToken).not.toHaveBeenCalled()
    // logged, but sanitized (no CRLF)
    expect(log.mock.calls.some(c => /access_denied/.test(String(c[0])) && !/\r|\n/.test(String(c[0])))).toBe(true)
  })

  it('502 when the token exchange throws (bank rejected the code)', async () => {
    const exchangeToken = async () => {
      throw new Error('token endpoint 400')
    }
    const { deps: d, saved } = deps()
    const r = await handleBankConnectCallback({ ...d, exchangeToken }, { query: { code: 'C', state: goodState }, nowMs: now })
    expect(r.status).toBe(502)
    expect(saved).toEqual([]) // nothing persisted on failure
  })

  it('400 when the provider is not configured for exchange (no client secret)', async () => {
    const r = await handleBankConnectCallback({ ...deps().deps, clientSecret: () => '' }, { query: { code: 'C', state: goodState }, nowMs: now })
    expect(r.status).toBe(400)
  })

  it('400 + no exchange when a valid signed state has no accountKey (old-format state)', async () => {
    const noAcct = signConnectState({ memberId: 'M1', provider: 'alfa-by', nonce: 'n1', exp: now + 600_000 } as never, SECRET)
    const exchangeToken = vi.fn(async () => tokenJson)
    const r = await handleBankConnectCallback({ ...deps().deps, exchangeToken }, { query: { code: 'C', state: noAcct }, nowMs: now })
    expect(r.status).toBe(400)
    expect(exchangeToken).not.toHaveBeenCalled()
  })

  it('502 + nothing saved + sanitized log when the token endpoint returns an error PAYLOAD', async () => {
    const log = vi.fn()
    const { deps: d, saved } = deps()
    const exchangeToken = async () => ({ error: 'invalid_grant', error_description: 'bad\r\ncode' })
    const r = await handleBankConnectCallback({ ...d, exchangeToken, log }, { query: { code: 'C', state: goodState }, nowMs: now })
    expect(r.status).toBe(502)
    expect(saved).toEqual([])
    expect(log.mock.calls.some(c => /invalid_grant/.test(String(c[0])) && !/\r|\n/.test(String(c[0])))).toBe(true)
  })

  it('502 + nothing saved when the token response omits refresh_token (half-token)', async () => {
    const { deps: d, saved } = deps()
    const exchangeToken = async () => ({ access_token: 'AT', token_type: 'Bearer', expires_in: 3600 })
    const r = await handleBankConnectCallback({ ...d, exchangeToken }, { query: { code: 'C', state: goodState }, nowMs: now })
    expect(r.status).toBe(502)
    expect(saved).toEqual([])
  })
})
