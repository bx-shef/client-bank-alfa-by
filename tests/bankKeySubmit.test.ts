import { describe, expect, it, vi } from 'vitest'
import { handleKeyRequestInfo, handleSubmitBankKey, type KeySubmitDeps } from '../server/utils/bankKeySubmit'
import { signKeyGrant } from '../server/utils/bankKeyGrant'

// Экран владельца счёта (#19): гейт гранта, приём ключа, уведомление открытых экранов.

const SECRET = 's'.repeat(48)
const NOW = Date.UTC(2026, 8, 13, 6, 0)
const DOMAIN = 'client.bitrix24.by'
const TOKEN = 'frame-token'
const GRANT = { memberId: 'M1', provider: 'alfa-by' as const, userId: '7', exp: NOW + 86_400_000 }
const T = signKeyGrant(GRANT, SECRET)

function deps(over: Partial<KeySubmitDeps> = {}): KeySubmitDeps {
  return {
    memberIdByDomain: vi.fn(async () => 'M1'),
    validateFrame: vi.fn(async () => ({ userId: '7', isAdmin: false })),
    config: () => ({ baseUrl: 'https://bank.test', clientId: 'cid' }),
    clientSecret: () => 'secret',
    exchange: vi.fn(async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })),
    save: vi.fn(async () => {}),
    secret: SECRET,
    clientId: () => 'shef-bank-import',
    notifyConnected: vi.fn(async () => {}),
    ...over
  }
}

const req = { accessToken: TOKEN, domain: DOMAIN, token: T, nowMs: NOW }
const sub = { ...req, apiKey: 'k'.repeat(64), nonce: 'n1' }

describe('гейт гранта — три условия, и ни одного достаточного', () => {
  it('годный грант у того самого человека ⇒ 200', async () => {
    const res = await handleKeyRequestInfo(deps(), req)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, provider: 'alfa-by', clientId: 'shef-bank-import' })
  })

  // ⚠ Грант едет в чате — его видит и получатель, и любой, кому тот перешлёт. Именно совпадение с
  // фрейм-токеном делает его безопасным.
  it('открыл ДРУГОЙ сотрудник ⇒ 403 и ни одного обращения к банку', async () => {
    const d = deps({ validateFrame: vi.fn(async () => ({ userId: '9', isAdmin: false })) })
    expect((await handleKeyRequestInfo(d, req)).status).toBe(403)
    const res = await handleSubmitBankKey(d, sub)
    expect(res.status).toBe(403)
    expect(d.exchange).not.toHaveBeenCalled()
    expect(d.save).not.toHaveBeenCalled()
  })

  // ⚠ Иначе ссылка, пересланная в ДРУГОЙ Bitrix24, где у человека тоже есть фрейм-токен,
  // подключила бы банк не тому порталу.
  it('другой портал ⇒ 403', async () => {
    const d = deps({ memberIdByDomain: vi.fn(async () => 'M2') })
    expect((await handleKeyRequestInfo(d, req)).status).toBe(403)
  })

  it('просроченный и подделанный грант ⇒ 403 без похода в портал', async () => {
    const expired = signKeyGrant({ ...GRANT, exp: NOW - 1 }, SECRET)
    for (const t of [expired, 'мусор', '']) {
      const d = deps()
      expect((await handleKeyRequestInfo(d, { ...req, token: t })).status).toBe(403)
      expect(d.memberIdByDomain).not.toHaveBeenCalled()
    }
  })

  it('отвергнутый фрейм-токен ⇒ 403', async () => {
    const d = deps({ validateFrame: vi.fn(async () => {
      throw new Error('bad token')
    }) })
    expect((await handleKeyRequestInfo(d, req)).status).toBe(403)
  })

  it('портал не установлен ⇒ 409', async () => {
    expect((await handleKeyRequestInfo(deps({ memberIdByDomain: vi.fn(async () => null) }), req)).status).toBe(409)
  })

  // ⚠ Админ-гейта здесь НЕТ намеренно: экран для того и заведён, чтобы им пользовался не админ.
  it('обычный сотрудник (не админ) с годным грантом проходит', async () => {
    const d = deps({ validateFrame: vi.fn(async () => ({ userId: '7', isAdmin: false })) })
    expect((await handleSubmitBankKey(d, sub)).status).toBe(200)
  })
})

describe('приём ключа', () => {
  it('ключ обменивается и подключение сохраняется под порталом ИЗ ГРАНТА', async () => {
    const d = deps()
    const res = await handleSubmitBankKey(d, sub)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ connected: true, provider: 'alfa-by' })
    const saved = (d.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { memberId: string, apiKey: string }
    expect(saved.memberId).toBe('M1')
    expect(saved.apiKey).toBe('k'.repeat(64))
  })

  // Провайдер берётся ИЗ ГРАНТА: грант, выданный другому банку, ключ Альфы не подключает.
  it('грант другого банка ⇒ 400 по-русски, в банк не ходим', async () => {
    const d = deps()
    const token = signKeyGrant({ ...GRANT, provider: 'prior-by' }, SECRET)
    const res = await handleSubmitBankKey(d, { ...sub, token })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toMatch(/другого банка/)
    expect(d.exchange).not.toHaveBeenCalled()
  })

  // ⚠ Форму ключа проверяем ДО гейта: пустое поле — самый частый исход, и он не должен стоить
  // ни обращения в портал, ни разбора подписи.
  it('пустой ключ ⇒ 400 без проверки гранта', async () => {
    const d = deps()
    const res = await handleSubmitBankKey(d, { ...sub, apiKey: '   ' })
    expect(res.status).toBe(400)
    expect(d.memberIdByDomain).not.toHaveBeenCalled()
  })

  it('банк отверг ключ ⇒ 502, текст банка наружу не уходит', async () => {
    const d = deps({ exchange: vi.fn(async () => {
      throw new Error('invalid_grant: bad key kkkkkkkk')
    }) })
    const res = await handleSubmitBankKey(d, sub)
    expect(res.status).toBe(502)
    expect(JSON.stringify(res.body)).not.toContain('invalid_grant')
  })
})

describe('уведомление открытых экранов', () => {
  // ⚠ Только на УДАЧЕ: послать «банк подключён» раньше записи значило бы показать администратору
  // подключение, которого нет.
  it('уходит после сохранения', async () => {
    const d = deps()
    await handleSubmitBankKey(d, sub)
    expect(d.notifyConnected).toHaveBeenCalledWith('M1', 'alfa-by')
  })

  it('при отказе банка не уходит', async () => {
    const d = deps({ exchange: vi.fn(async () => {
      throw new Error('nope')
    }) })
    await handleSubmitBankKey(d, sub)
    expect(d.notifyConnected).not.toHaveBeenCalled()
  })

  // ⚠ Подключение уже создано — ронять из-за уведомления ответ значило бы просить владельца счёта
  // ввести ключ второй раз.
  it('провал уведомления не меняет исход', async () => {
    const d = deps({ notifyConnected: vi.fn(async () => {
      throw new Error('pull down')
    }) })
    expect((await handleSubmitBankKey(d, sub)).status).toBe(200)
  })
})

describe('состояние сервера', () => {
  it('без client_id экран не показываем ⇒ 503, и текст называет переменную по-русски', async () => {
    const res = await handleKeyRequestInfo(deps({ clientId: () => '' }), req)
    expect(res.status).toBe(503)
    expect(String(res.body.error)).toContain('ALFA_OAUTH_CLIENT_ID')
  })

  it('без секрета подписи любой грант негоден ⇒ 403', async () => {
    expect((await handleKeyRequestInfo(deps({ secret: '' }), req)).status).toBe(403)
  })
})
