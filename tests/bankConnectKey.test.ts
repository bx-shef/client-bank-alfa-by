import { describe, expect, it, vi } from 'vitest'
import { handleBankConnectKey, type ConnectKeyDeps } from '../server/utils/bankConnectKey'
import type { BankToken } from '../server/utils/bankTokenStore'

// Подключение Альфы КЛЮЧОМ API (#488). Проверяется три вещи: те же гейты, что у authorize-пути;
// форма запроса к банку; и то, что ключ не вытекает наружу ни на одной ветке.

const KEY = 'SUPER-SECRET-API-KEY-VALUE-0123456789'
const SECRET = 'client-secret-value'

function deps(over: Partial<ConnectKeyDeps> = {}): {
  d: ConnectKeyDeps
  saved: BankToken[]
  logs: string[]
  sent: URLSearchParams[]
} {
  const saved: BankToken[] = []
  const logs: string[] = []
  const sent: URLSearchParams[] = []
  const d: ConnectKeyDeps = {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '1', isAdmin: true }),
    config: () => ({ baseUrl: 'https://bank.test:8273', clientId: 'CID', redirectUri: 'https://app/cb' }),
    clientSecret: () => SECRET,
    exchange: async (_base, body) => {
      sent.push(body)
      return { access_token: 'ACC', refresh_token: 'REF', token_type: 'Bearer', expires_in: 3600 }
    },
    save: async (t) => { saved.push(t) },
    log: m => logs.push(m),
    ...over
  }
  return { d, saved, logs, sent }
}

const input = {
  accessToken: 'frame-token', domain: 'p.bitrix24.by', provider: 'alfa-by' as const,
  apiKey: KEY, nonce: 'n-1', nowMs: 1_700_000_000_000
}

describe('#488 подключение ключом: гейты те же, что у authorize-пути', () => {
  it('без фрейм-авторизации — 400, портал не спрашиваем', async () => {
    const { d } = deps({ memberIdByDomain: vi.fn(async () => 'M1') })
    expect((await handleBankConnectKey(d, { ...input, accessToken: '' })).status).toBe(400)
    expect(d.memberIdByDomain).not.toHaveBeenCalled()
  })

  it('портал не установлен — 409', async () => {
    const { d } = deps({ memberIdByDomain: async () => null })
    expect((await handleBankConnectKey(d, input)).status).toBe(409)
  })

  it('фрейм-токен не от этого портала — 403', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('nope')
    }
    const { d } = deps({ validateFrame: boom })
    expect((await handleBankConnectKey(d, input)).status).toBe(403)
  })

  it('не администратор — 403, банк не трогаем', async () => {
    const { d, sent } = deps({ validateFrame: async () => ({ userId: '2', isAdmin: false }) })
    expect((await handleBankConnectKey(d, input)).status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('нет «моей компании» — 409 с причиной', async () => {
    const { d, sent } = deps({ myCompanyGate: async () => 'no-account' })
    const r = await handleBankConnectKey(d, input)
    expect(r.status).toBe(409)
    expect(r.body.reason).toBe('no-account')
    // ⚠ Ключ не потрачен: обмен не состоялся. Иначе человек отдал бы ключ ради отказа.
    expect(sent).toHaveLength(0)
  })
})

describe('#488 подключение ключом: что уходит в банк', () => {
  it('grant_type=password, ключ в username, scope только accounts', async () => {
    const { d, sent } = deps()
    expect((await handleBankConnectKey(d, input)).status).toBe(200)
    const body = sent[0]!
    expect(body.get('grant_type')).toBe('password')
    expect(body.get('username')).toBe(KEY)
    expect(body.get('client_id')).toBe('CID')
    expect(body.get('client_secret')).toBe(SECRET)
    expect(body.get('scope')).toBe('accounts')
    // ⚠ Ни кода, ни redirect_uri: это не authorize-путь, и лишние поля банк вправе отвергнуть.
    expect(body.get('code')).toBeNull()
    expect(body.get('redirect_uri')).toBeNull()
  })

  it('провайдер не настроен — 400 БЕЗ обращения к порталу и банку', async () => {
    const { d, sent } = deps({ config: () => null, memberIdByDomain: vi.fn(async () => 'M1') })
    expect((await handleBankConnectKey(d, input)).status).toBe(400)
    expect(d.memberIdByDomain).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('нет client_secret — 503 fail-closed', async () => {
    const { d, sent } = deps({ clientSecret: () => '' })
    expect((await handleBankConnectKey(d, input)).status).toBe(503)
    expect(sent).toHaveLength(0)
  })

  it.each([['пустой', '   '], ['гигантский', 'x'.repeat(5000)]])('%s ключ — 400', async (_n, k) => {
    const { d, sent } = deps()
    expect((await handleBankConnectKey(d, { ...input, apiKey: k })).status).toBe(400)
    expect(sent).toHaveLength(0)
  })
})

describe('#488 подключение ключом: секреты не вытекают', () => {
  it('банк отверг — 502, и ни ключа, ни секрета, ни текста банка наружу', async () => {
    // ⚠ Банк в ответе на негодный ключ повторяет присланные параметры — то есть в тексте ошибки
    // лежит и сам ключ, и client_secret. Отдать его человеку значило бы положить их в переписку,
    // а в лог — в файл, который живёт до вытеснения по объёму.
    const { d, logs } = deps({
      exchange: async () => { throw new Error(`invalid_grant: username=${KEY} client_secret=${SECRET}`) }
    })
    const r = await handleBankConnectKey(d, input)
    expect(r.status).toBe(502)
    const out = JSON.stringify(r.body) + logs.join('\n')
    expect(out).not.toContain(KEY)
    expect(out).not.toContain(SECRET)
    // При этом человеку сказано, что делать.
    expect(String(r.body.error)).toMatch(/ключ API/)
  })

  it('успех — ключа нет и в ответе тоже', async () => {
    const { d } = deps()
    const r = await handleBankConnectKey(d, input)
    expect(JSON.stringify(r.body)).not.toContain(KEY)
  })
})

describe('#488 подключение ключом: что сохраняем', () => {
  it('ключ, пара токенов, грант из nonce и временный ключ счёта', async () => {
    const { d, saved } = deps()
    await handleBankConnectKey(d, input)
    const t = saved[0]!
    expect(t.memberId).toBe('M1')
    expect(t.apiKey).toBe(KEY)
    expect(t.accessToken).toBe('ACC')
    expect(t.refreshToken).toBe('REF')
    expect(t.grantId).toBe('n-1')
    // Счёт выбирают прежним экраном — подключение приземляется под временным ключом (#407).
    expect(t.accountKey).toMatch(/^~pending:/)
    // ⚠ Согласий у Альфы нет вовсе: 0 значит «неизвестно», а не «истекло» (#503).
    expect(t.consentExpiresAt).toBe(0)
    expect(t.expiresAt).toBe(input.nowMs + 3600 * 1000)
  })

  it('ключ сохраняется ОБРЕЗАННЫМ по краям — вставка из буфера тащит пробел', async () => {
    const { d, saved, sent } = deps()
    await handleBankConnectKey(d, { ...input, apiKey: `  ${KEY}\n` })
    expect(saved[0]!.apiKey).toBe(KEY)
    expect(sent[0]!.get('username')).toBe(KEY)
  })
})
