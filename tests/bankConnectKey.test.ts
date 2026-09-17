import { describe, expect, it } from 'vitest'
import { exchangeAndSaveKey, precheckKeyConnect, type ConnectKeyDeps } from '../server/utils/bankConnectKey'
import type { BankToken } from '../server/utils/bankTokenStore'

// Обмен ключа API Альфы на пару токенов (#488). Проверяется три вещи: форма запроса к банку, то,
// что ключ не вытекает наружу ни на одной ветке, и что именно мы сохраняем.
//
// ⚠ Тесты бьют по `precheckKeyConnect`/`exchangeAndSaveKey` НАПРЯМУЮ, а не через обёртку-маршрут.
// Прежде такой обёрткой был админский `handleBankConnectKey` — он снят вместе с самостоятельным
// подключением (решение владельца 2026-09-17), и ключ теперь вводит ТОЛЬКО владелец счёта на
// `/bank-key`. Гейт того пути (подписанный грант + совпадение личности) живёт в
// `bankKeySubmit.test.ts`; здесь — механика обмена, общая и неизменная.

const KEY = 'SUPER-SECRET-API-KEY-VALUE-0123456789'
const SECRET = 'client-secret-value'

type Deps = Pick<ConnectKeyDeps, 'config' | 'clientSecret' | 'exchange' | 'save' | 'log'>

function deps(over: Partial<Deps> = {}): { d: Deps, saved: BankToken[], logs: string[], sent: URLSearchParams[] } {
  const saved: BankToken[] = []
  const logs: string[] = []
  const sent: URLSearchParams[] = []
  const d: Deps = {
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
  memberId: 'M1', provider: 'alfa-by' as const,
  apiKey: KEY, nonce: 'n-1', nowMs: 1_700_000_000_000
}

/** Тот же порядок, что у живого вызывающего: сперва дешёвые проверки, потом поход в банк. */
async function connect(d: Deps, over: Partial<typeof input> = {}) {
  const i = { ...input, ...over }
  return precheckKeyConnect(d, i.provider, i.apiKey) ?? await exchangeAndSaveKey(d, i)
}

describe('что уходит в банк', () => {
  it('grant_type=password, ключ в username, scope только accounts', async () => {
    const { d, sent } = deps()
    expect((await connect(d)).status).toBe(200)
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

  it('провайдер не настроен — 400 БЕЗ обращения к банку', async () => {
    const { d, sent } = deps({ config: () => null })
    expect((await connect(d)).status).toBe(400)
    expect(sent).toHaveLength(0)
  })

  it('нет client_secret — 503 fail-closed', async () => {
    const { d, sent } = deps({ clientSecret: () => '' })
    expect((await connect(d)).status).toBe(503)
    expect(sent).toHaveLength(0)
  })

  it.each([['пустой', '   '], ['гигантский', 'x'.repeat(5000)]])('%s ключ — 400', async (_n, k) => {
    const { d, sent } = deps()
    expect((await connect(d, { apiKey: k })).status).toBe(400)
    expect(sent).toHaveLength(0)
  })
})

describe('секреты не вытекают', () => {
  it('банк отверг — 502, и ни ключа, ни секрета, ни текста банка наружу', async () => {
    // ⚠ Банк в ответе на негодный ключ повторяет присланные параметры — то есть в тексте ошибки
    // лежит и сам ключ, и client_secret. Отдать его человеку значило бы положить их в переписку,
    // а в лог — в файл, который живёт до вытеснения по объёму.
    const { d, logs } = deps({
      exchange: async () => { throw new Error(`invalid_grant: username=${KEY} client_secret=${SECRET}`) }
    })
    const r = await connect(d)
    expect(r.status).toBe(502)
    const out = JSON.stringify(r.body) + logs.join('\n')
    expect(out).not.toContain(KEY)
    expect(out).not.toContain(SECRET)
    // При этом человеку сказано, что делать.
    expect(String(r.body.error)).toMatch(/ключ API/)
  })

  // ⚠ ЖИВАЯ НАХОДКА 2026-09-09. Первая редакция логировала одно имя класса исключения
  // (`deps.log(e.name)` → «Error»), и отказ стал НЕРАЗБИРАЕМЫМ: админ получил «банк не принял ключ
  // API» и не мог узнать, дело в ключе, в `client_id`, в адресе (песочница вместо боевого) или в
  // сети — а чинятся эти четыре причины в четырёх разных местах. Тест держит ОБА свойства сразу,
  // потому что по отдельности каждое чинится неправильно: молчание «ради безопасности» и
  // болтливость «ради диагностики».
  it('причина отказа ПОПАДАЕТ В ЛОГ — иначе чинить нечего', async () => {
    const { d, logs } = deps({
      exchange: async () => {
        throw Object.assign(new Error('[POST] "https://bank.test:8273/token": 400 Bad Request'), {
          data: { error: 'invalid_client', error_description: 'client credentials are invalid' }
        })
      }
    })
    await connect(d)
    const line = logs.join('\n')
    // Код ошибки банка — то единственное, что различает причины.
    expect(line).toContain('invalid_client')
    expect(line).toContain('400')
    // И по-прежнему без секретов (их в этом ответе нет, но проверка держит инвариант на месте).
    expect(line).not.toContain(KEY)
    expect(line).not.toContain(SECRET)
  })

  it('лог однострочный: перевод строки из ответа банка не подделает соседнюю запись', async () => {
    const { d, logs } = deps({
      exchange: async () => {
        throw new Error('invalid_grant\r\n[bank-connect] INFO: подключено')
      }
    })
    await connect(d)
    expect(logs.join('')).not.toMatch(/[\r\n]/)
  })

  it('успех — ключа нет и в ответе тоже', async () => {
    const { d } = deps()
    const r = await connect(d)
    expect(JSON.stringify(r.body)).not.toContain(KEY)
  })
})

describe('что сохраняем', () => {
  it('ключ, пара токенов, грант из nonce и временный ключ счёта', async () => {
    const { d, saved } = deps()
    await connect(d)
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
    await connect(d, { apiKey: `  ${KEY}\n` })
    expect(saved[0]!.apiKey).toBe(KEY)
    expect(sent[0]!.get('username')).toBe(KEY)
  })
})
