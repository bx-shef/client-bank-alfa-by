import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bankConnectConfigFromEnv,
  handleBankConnectStart,
  CONNECT_STATE_TTL_MS,
  type ConnectStartDeps
} from '../server/utils/bankConnectStart'
import { verifyConnectState } from '../server/utils/bankConnectState'
import type { PriorConnectConfig } from '../server/utils/priorConnectStart'
import { parseOAuthCallback } from '../app/utils/alfaOauth'

const SECRET = 'connect-secret'
const now = 1_700_000_000_000

const CONFIG = { baseUrl: 'https://alfa:8273', clientId: 'CID', redirectUri: 'https://app/cb', scope: 'accounts' }

/** Prior's connect config (multi-step, carries secrets — A5b). */
const PRIOR_CONFIG: PriorConnectConfig = {
  baseUrl: 'https://prior:9344',
  // ⚠ Отдельно от `baseUrl` намеренно (#455/#522): банк разводит сервер авторизации и ресурсный
  // API по разным адресам. Фикстура жила без этого поля, потому что типы её не проверяли.
  tokenUrl: 'https://prior:9344/oauth2/token',
  authorizeBaseUrl: 'https://prior:9344',
  clientId: 'PCID',
  clientSecret: 'PSECRET',
  redirectUri: 'https://app/cb',
  audience: 'https://prior:9544/oauth2/token',
  privateKeyPem: 'PEM',
  kid: 'k1'
}

function deps(over: Partial<ConnectStartDeps> = {}): ConnectStartDeps {
  return {
    memberIdByDomain: async () => 'MEMBER1',
    validateFrame: async () => ({ userId: 'USER9', isAdmin: true }),
    config: () => CONFIG,
    priorConfig: () => null, // Prior unconfigured by default; the Prior tests opt in
    // Подписчик, а не строка (#503): дату согласия можно положить в state только ЗДЕСЬ, после
    // ответа банка. Фейк изображает банк, вернувший срок.
    buildPriorUrl: async (_c, signState) => `https://prior:9344/authorize?state=${signState({ consentExpiresAt: PRIOR_CONSENT_AT })}&request=JWT`,
    secret: SECRET,
    ...over
  }
}

const input = {
  accessToken: 'TKN', domain: 'p.bitrix24.by', provider: 'alfa-by' as const,
  accountKey: 'BY13ALFA', nonce: 'nonce123', nowMs: now
}

const PRIOR_CONSENT_AT = 1_800_000_000_000

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
  it('prior-by / manual → null (Prior has its own config/flow; manual has no OAuth)', () => {
    expect(bankConnectConfigFromEnv('prior-by')).toBeNull()
    expect(bankConnectConfigFromEnv('manual')).toBeNull()
  })
})

describe('handleBankConnectStart — Prior (A5b, live preamble)', () => {
  const priorInput = { ...input, provider: 'prior-by' as const }

  it('400 when Prior is not configured (no env) — same clean refusal as an unknown provider', async () => {
    const buildPriorUrl = vi.fn(async () => 'X')
    const r = await handleBankConnectStart(deps({ priorConfig: () => null, buildPriorUrl }), priorInput)
    expect(r.status).toBe(400)
    expect(buildPriorUrl).not.toHaveBeenCalled() // no bank round-trip on an unconfigured provider
  })

  it('runs the preamble and returns its authorize URL, passing the SIGNED state', async () => {
    // Преамбуле передаётся ПОДПИСЧИК, а не готовая строка (#503): дату согласия видно только
    // здесь, после ответа банка, и положить её в state можно лишь в этот момент.
    type Sign = (extra: { consentExpiresAt: number | null }) => string
    const buildPriorUrl = vi.fn(async (_c: unknown, sign: Sign) =>
      `https://prior/auth?state=${sign({ consentExpiresAt: PRIOR_CONSENT_AT })}`)
    const r = await handleBankConnectStart(deps({ priorConfig: () => PRIOR_CONFIG, buildPriorUrl }), priorInput)
    expect(r.status).toBe(200)
    expect(buildPriorUrl).toHaveBeenCalledOnce()
    // The state handed to the preamble is our signed state and verifies back to OUR memberId.
    const state = buildPriorUrl.mock.calls[0]![1]({ consentExpiresAt: PRIOR_CONSENT_AT })
    const verified = verifyConnectState(state, SECRET, now)
    expect(verified?.memberId).toBe('MEMBER1')
    expect(verified?.provider).toBe('prior-by')
    expect(verified?.accountKey).toBe('BY13ALFA')
    // Срок согласия доехал в подписанном state — иначе колбэку неоткуда его взять.
    expect(verified?.consentExpiresAt).toBe(PRIOR_CONSENT_AT)
    expect(r.body.authorizeUrl).toContain(state)
    // Prior's config is used — the Alfa config is NOT consulted for a Prior connect.
    expect(buildPriorUrl.mock.calls[0]![0]).toEqual(PRIOR_CONFIG)
  })

  it('502 when the bank preamble fails (well-formed request, upstream problem) + SANITIZED log', async () => {
    const log = vi.fn()
    const buildPriorUrl = async () => {
      throw new Error('consent 500\r\ninjected')
    }
    const r = await handleBankConnectStart(deps({ priorConfig: () => PRIOR_CONFIG, buildPriorUrl, log }), priorInput)
    expect(r.status).toBe(502)
    expect(String(r.body.error)).not.toContain('consent 500') // raw bank/internal text is not surfaced
    // …but it IS logged, sanitized — otherwise the 4-step preamble would be unobservable.
    expect(log.mock.calls.some(c => /consent 500/.test(String(c[0])) && !/\r|\n/.test(String(c[0])))).toBe(true)
  })

  // ⚠ The test above passes with either logger, because an Error WITHOUT `.data` renders the same
  // through both. The whole point of the change is the bank's error ENVELOPE — ofetch puts the
  // status in `.message` and the cause in `.data`, and «400 Bad Request» alone is identical for a
  // missing header, a rejected field and an expired token. Without this case the integration point
  // could be reverted to `sanitizeForLog(e.message)` and the suite would stay green.
  it('logs the bank ERROR ENVELOPE, not just the status line', async () => {
    const log = vi.fn()
    const buildPriorUrl = async () => {
      throw Object.assign(new Error('[POST] "https://bank/accountConsents": 400 Bad Request'), {
        data: { errors: [{ errorCode: 'BY.NBRB.Field.Invalid', path: 'data.expirationDate' }] }
      })
    }
    const r = await handleBankConnectStart(deps({ priorConfig: () => PRIOR_CONFIG, buildPriorUrl, log }), priorInput)
    expect(r.status).toBe(502)
    // The admin still gets our own opaque text — bank-controlled strings never reach them.
    expect(String(r.body.error)).not.toContain('BY.NBRB')
    expect(log.mock.calls.some(c => /BY\.NBRB\.Field\.Invalid/.test(String(c[0])))).toBe(true)
  })

  it('still enforces the admin gate and the portal check BEFORE any bank round-trip', async () => {
    const buildPriorUrl = vi.fn(async () => 'X')
    const notAdmin = await handleBankConnectStart(
      deps({ priorConfig: () => PRIOR_CONFIG, buildPriorUrl, validateFrame: async () => ({ userId: 'U', isAdmin: false }) }),
      priorInput
    )
    expect(notAdmin.status).toBe(403)
    const notInstalled = await handleBankConnectStart(
      deps({ priorConfig: () => PRIOR_CONFIG, buildPriorUrl, memberIdByDomain: async () => null }),
      priorInput
    )
    expect(notInstalled.status).toBe(409)
    expect(buildPriorUrl).not.toHaveBeenCalled()
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
    expect(state).toMatchObject({ memberId: 'MEMBER1', provider: 'alfa-by', accountKey: 'BY13ALFA', nonce: 'nonce123' })
    expect(state!.exp).toBe(now + CONNECT_STATE_TTL_MS)
    // parseOAuthCallback (the callback's verifier) accepts this exact state for a matching code.
    expect(parseOAuthCallback({ code: 'C', state: url.searchParams.get('state')! }, url.searchParams.get('state')!)).toEqual({ code: 'C' })
  })

  it('400 without frame auth / provider / MALFORMED account', async () => {
    expect((await handleBankConnectStart(deps(), { ...input, accessToken: '' })).status).toBe(400)
    expect((await handleBankConnectStart(deps(), { ...input, domain: '' })).status).toBe(400)
    expect((await handleBankConnectStart(deps(), { ...input, provider: '' as 'alfa-by' })).status).toBe(400)
    // Непустой, но кривой — по-прежнему отказ: молча превращать мусор во временный ключ хуже.
    expect((await handleBankConnectStart(deps(), { ...input, accountKey: 'has spaces' })).status).toBe(400)
    expect((await handleBankConnectStart(deps(), { ...input, accountKey: 'a/b#c' })).status).toBe(400)
  })

  it('счёт НЕ обязателен (#407): без него подключение стартует, в state счёта нет', async () => {
    // Порядок «сначала банк, потом счёт»: до авторизации админ не обязан помнить IBAN, а после неё
    // счёт выбирается из того, что отдал банк. Токен приземлится под временным ключом (см. колбэк).
    const r = await handleBankConnectStart(deps(), { ...input, accountKey: '' })
    expect(r.status).toBe(200)
    const url = new URL(String(r.body.authorizeUrl))
    const state = verifyConnectState(url.searchParams.get('state') ?? undefined, SECRET, input.nowMs)
    expect(state?.accountKey).toBeUndefined()
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

// Гейт «моей компании» (#493) на СТАРТЕ подключения. Здесь цена ошибки выше, чем при загрузке
// файла: поток просит владельца счёта ввести пароль от интернет-банка и дать согласие на доступ к
// деньгам компании. Потратить это на настройку, которая не может дать ни одной записи, — дорого.
describe('handleBankConnectStart — предусловие «моя компания» (#493)', () => {
  it('нет «моей компании» → 409, и в банк мы даже не собираемся', async () => {
    let built = false
    const r = await handleBankConnectStart(deps({
      myCompanyGate: async () => 'no-company',
      buildPriorUrl: async () => {
        built = true
        return 'x'
      }
    }), input)
    expect(r.status).toBe(409)
    expect(r.body.reason).toBe('no-company')
    expect(built).toBe(false)
  })

  it('нет счёта в реквизитах → своя причина', async () => {
    const r = await handleBankConnectStart(deps({ myCompanyGate: async () => 'no-account' }), input)
    expect(r.status).toBe(409)
    expect(r.body.reason).toBe('no-account')
  })

  it('CRM не ответила → подключение ПРОХОДИТ (fail-open)', async () => {
    const r = await handleBankConnectStart(deps({
      myCompanyGate: async () => {
        throw new Error('rest down')
      }
    }), input)
    expect(r.status).toBe(200)
    expect(r.body.authorizeUrl).toBeTruthy()
  })

  it('не-админа отшивает admin-гейт, а не гейт компании — порядок проверок не переставлен', async () => {
    let asked = false
    const r = await handleBankConnectStart(deps({
      validateFrame: async () => ({ userId: 'U', isAdmin: false }),
      myCompanyGate: async () => {
        asked = true
        return 'ok'
      }
    }), input)
    expect(r.status).toBe(403)
    expect(asked).toBe(false)
  })
})
