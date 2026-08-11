import { describe, expect, it, vi } from 'vitest'
import { handleBankConnectCallback, type CallbackDeps } from '../server/utils/bankConnectCallback'
import { sanitizeForLog } from '../server/utils/logSanitize'
import { signConnectState } from '../server/utils/bankConnectState'
import { provisionalAccountKey } from '../app/utils/bankAccountKey'
import { PRIOR_CLIENT_ASSERTION_TYPE } from '../app/utils/priorOauth'
import type { BankToken } from '../server/utils/bankTokenStore'
import { Buffer } from 'node:buffer'

const SECRET = 'cb-secret'
const now = 1_700_000_000_000
const CONFIG = { baseUrl: 'https://alfa:8273', clientId: 'CID', redirectUri: 'https://app/cb' }

const goodState = signConnectState(
  { memberId: 'M1', provider: 'alfa-by', accountKey: 'BY13ALFA', nonce: 'n1', exp: now + 600_000 },
  SECRET
)

const tokenJson = { access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer', expires_in: 3600 }

/** Prior's connect config (multi-step, carries its own secrets — A5b). */
const PRIOR_CONFIG = {
  baseUrl: 'https://prior:9344',
  authorizeBaseUrl: 'https://prior:9344',
  clientId: 'PCID',
  clientSecret: 'PSECRET',
  redirectUri: 'https://app/cb',
  audience: 'https://prior:9544/oauth2/token',
  privateKeyPem: 'PEM',
  kid: 'k1'
}

const priorState = signConnectState(
  { memberId: 'M1', provider: 'prior-by', accountKey: 'BY13PRIOR', nonce: 'n1', exp: now + 600_000 },
  SECRET
)

function deps(over: Partial<CallbackDeps> & { saved?: BankToken[] } = {}) {
  const saved: BankToken[] = over.saved ?? []
  const d: CallbackDeps = {
    secret: SECRET,
    config: () => CONFIG,
    clientSecret: () => 'CSECRET',
    exchangeToken: async () => tokenJson,
    priorConfig: () => null, // Prior unconfigured by default; the Prior tests opt in
    exchangePriorToken: async () => tokenJson,
    // Default to the sandbox method; the private_key_jwt case overrides it.
    priorTokenAuth: c => ({ method: 'client_secret_basic', clientId: c.clientId, clientSecret: c.clientSecret }),
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

  it('state без счёта (#407) → токен сохраняется под ВРЕМЕННЫМ ключом, а не отвергается', async () => {
    // Порядок «сначала банк, потом счёт»: подключение стартует без IBAN, и счёт выбирается уже
    // после возврата. Уникальность временного ключа даёт nonce — два параллельных подключения
    // одного админа иначе затёрли бы друг друга.
    const noAcct = signConnectState({ memberId: 'M1', provider: 'alfa-by', nonce: 'n1', exp: now + 600_000 } as never, SECRET)
    const { deps: d, saved } = deps()
    const r = await handleBankConnectCallback(d, { query: { code: 'C', state: noAcct }, nowMs: now })
    expect(r.status).toBe(200)
    expect(saved).toHaveLength(1)
    expect((saved[0] as { accountKey: string }).accountKey).toBe(provisionalAccountKey('n1'))
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

describe('handleBankConnectCallback — Prior (A5b)', () => {
  const q = { code: 'C', state: priorState }

  it('exchanges via the Prior endpoint with client_secret_basic creds (never in the body)', async () => {
    const exchangePriorToken = vi.fn(async () => tokenJson)
    const exchangeToken = vi.fn(async () => tokenJson)
    const { deps: d, saved } = deps({ priorConfig: () => PRIOR_CONFIG, exchangePriorToken, exchangeToken })
    const r = await handleBankConnectCallback(d, { query: q, nowMs: now })

    expect(r.status).toBe(200)
    expect(exchangeToken).not.toHaveBeenCalled() // the Alfa path is NOT used for a Prior state
    expect(exchangePriorToken).toHaveBeenCalledOnce()

    const [url, body, headers] = exchangePriorToken.mock.calls[0]!
    expect(url).toBe('https://prior:9344/open-banking-authorize/v1.0/oauth2/token')
    const form = new URLSearchParams(body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('C')
    expect(form.get('redirect_uri')).toBe(PRIOR_CONFIG.redirectUri)
    expect(body).not.toContain('PSECRET') // secret rides in the header, not the body
    expect(headers.authorization).toBe('Basic ' + Buffer.from('PCID:PSECRET').toString('base64'))

    // Persisted under the portal/provider/account the VERIFIED state carries.
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ memberId: 'M1', provider: 'prior-by', accountKey: 'BY13PRIOR', accessToken: 'AT' })
  })

  it('private_key_jwt: assertion in the BODY, no Authorization header (#444)', async () => {
    const exchangePriorToken = vi.fn(async () => tokenJson)
    const { deps: d, saved } = deps({
      priorConfig: () => PRIOR_CONFIG,
      exchangePriorToken,
      priorTokenAuth: () => ({ method: 'private_key_jwt', assertion: 'HEAD.PAY.SIG' })
    })
    const r = await handleBankConnectCallback(d, { query: q, nowMs: now })

    expect(r.status).toBe(200)
    const [, body, headers] = exchangePriorToken.mock.calls[0]!
    const form = new URLSearchParams(body)
    expect(form.get('client_assertion')).toBe('HEAD.PAY.SIG')
    expect(form.get('client_assertion_type')).toBe(PRIOR_CLIENT_ASSERTION_TYPE)
    expect(form.get('code')).toBe('C') // the grant params still ride along
    expect(headers).toEqual({}) // no Basic header under private_key_jwt
    expect(body).not.toContain('PSECRET')
    expect(saved).toHaveLength(1)
  })

  it('tolerates an omitted refresh_token (Prior may not rotate one) — stores empty, still connects', async () => {
    const exchangePriorToken = async () => ({ access_token: 'AT', token_type: 'Bearer', expires_in: 3600 })
    const { deps: d, saved } = deps({ priorConfig: () => PRIOR_CONFIG, exchangePriorToken })
    const r = await handleBankConnectCallback(d, { query: q, nowMs: now })
    expect(r.status).toBe(200)
    expect(saved[0]!.refreshToken).toBe('')
  })

  it('400 + nothing saved when Prior is not configured', async () => {
    const exchangePriorToken = vi.fn(async () => tokenJson)
    const { deps: d, saved } = deps({ priorConfig: () => null, exchangePriorToken })
    const r = await handleBankConnectCallback(d, { query: q, nowMs: now })
    expect(r.status).toBe(400)
    expect(exchangePriorToken).not.toHaveBeenCalled()
    expect(saved).toEqual([])
  })

  it('502 + nothing saved + sanitized log on a Prior OAuth error payload', async () => {
    const log = vi.fn()
    const exchangePriorToken = async () => ({ error: 'invalid_grant', error_description: 'bad\r\ncode' })
    const { deps: d, saved } = deps({ priorConfig: () => PRIOR_CONFIG, exchangePriorToken, log })
    const r = await handleBankConnectCallback(d, { query: q, nowMs: now })
    expect(r.status).toBe(502)
    expect(saved).toEqual([])
    expect(log.mock.calls.some(c => /invalid_grant/.test(String(c[0])) && !/\r|\n/.test(String(c[0])))).toBe(true)
  })
})
