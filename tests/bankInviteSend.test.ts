import { describe, expect, it, vi } from 'vitest'
import { handleSendBankInvite, type InviteSendDeps } from '../server/utils/bankInviteSend'

// «Передать владельцу счёта» (#19): гейт, выпуск ссылки, доставка, запоминание адресата.

const TOKEN = 'frame-token'
const DOMAIN = 'client.bitrix24.by'
const LINK = 'https://api.priorbank.by:9344/authorize?request=eyJ'
const KEY_LINK = 'https://client.bitrix24.by/marketplace/view/shef.bankimport/?params[place]=app-bank-key&params[t]=sig'

function deps(over: Partial<InviteSendDeps> = {}): InviteSendDeps {
  return {
    memberIdByDomain: vi.fn(async () => 'M1'),
    validateFrame: vi.fn(async () => ({ userId: '1', isAdmin: true })),
    priorConfig: () => ({ clientId: 'c' } as never),
    buildPriorUrl: vi.fn(async () => LINK),
    secret: 's'.repeat(32),
    sendMessage: vi.fn(async () => {}),
    rememberContact: vi.fn(async () => {}),
    alfaClientId: () => 'shef-bank-import',
    keyScreenLink: vi.fn(() => KEY_LINK),
    ...over
  }
}

const input = {
  accessToken: TOKEN, domain: DOMAIN, provider: 'prior-by' as const,
  userId: '7', userName: 'Иванова А.', nonce: 'n1', nowMs: Date.UTC(2026, 8, 13, 5, 0)
}

describe('гейт — тот же, что у «Подключить»', () => {
  it('не-админ получает 403 и ничего не отправляется', async () => {
    const d = deps({ validateFrame: vi.fn(async () => ({ userId: '2', isAdmin: false })) })
    const res = await handleSendBankInvite(d, input)
    expect(res.status).toBe(403)
    expect(d.sendMessage).not.toHaveBeenCalled()
  })

  it('портал не установлен ⇒ 409', async () => {
    const res = await handleSendBankInvite(deps({ memberIdByDomain: vi.fn(async () => null) }), input)
    expect(res.status).toBe(409)
  })

  it('отвергнутый фрейм-токен ⇒ 403', async () => {
    const d = deps({ validateFrame: vi.fn(async () => {
      throw new Error('bad token')
    }) })
    expect((await handleSendBankInvite(d, input)).status).toBe(403)
  })

  it('без токена/домена ⇒ 400, портал не спрашиваем вовсе', async () => {
    const d = deps()
    const res = await handleSendBankInvite(d, { ...input, accessToken: '' })
    expect(res.status).toBe(400)
    expect(d.memberIdByDomain).not.toHaveBeenCalled()
  })
})

describe('адресат проверяется ДО похода в портал', () => {
  // ⚠ Опечатка в идентификаторе не должна стоить REST-вызова, а главное — сообщение ушло бы не
  // тому человеку, и узнать об этом было бы неоткуда.
  it.each(['', '0', 'abc', '7 '])('кривой userId %s ⇒ 400 без REST', async (userId) => {
    const d = deps()
    const res = await handleSendBankInvite(d, { ...input, userId })
    expect(res.status).toBe(400)
    expect(d.memberIdByDomain).not.toHaveBeenCalled()
  })

  it('неподключаемый банк ⇒ 400', async () => {
    const res = await handleSendBankInvite(deps(), { ...input, provider: 'manual' })
    expect(res.status).toBe(400)
  })
})

describe('Приорбанк: ссылка выпускается ЗДЕСЬ', () => {
  it('уходит сообщение со свежей ссылкой, адресат запоминается', async () => {
    const d = deps()
    const res = await handleSendBankInvite(d, input)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ sent: true, provider: 'prior-by', userId: '7', ttlMin: 15 })
    const [memberId, dialogId, text] = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(memberId).toBe('M1')
    expect(dialogId).toBe('7') // личный чат сотрудника
    expect(text).toContain(LINK)
    expect(d.rememberContact).toHaveBeenCalledWith(TOKEN, DOMAIN, { userId: '7', name: 'Иванова А.' })
  })

  // ⚠ Отказ банка отдаём КАК ЕСТЬ: второй слой формулировок («не удалось отправить») скрыл бы,
  // что дело не в чате, а в подключении.
  it('провал преамбулы банка ⇒ 502 и ни одного сообщения', async () => {
    const d = deps({ buildPriorUrl: vi.fn(async () => {
      throw new Error('bank down')
    }) })
    const res = await handleSendBankInvite(d, input)
    expect(res.status).toBe(502)
    expect(d.sendMessage).not.toHaveBeenCalled()
  })

  it('нет секрета подписи ⇒ 503 до всего остального', async () => {
    const d = deps({ secret: '' })
    expect((await handleSendBankInvite(d, input)).status).toBe(503)
    expect(d.memberIdByDomain).not.toHaveBeenCalled()
  })
})

describe('Альфа-Банк: инструкция вместо ссылки', () => {
  const alfa = { ...input, provider: 'alfa-by' as const }

  it('отправляется инструкция по выпуску ключа, в банк не ходим', async () => {
    const d = deps()
    const res = await handleSendBankInvite(d, alfa)
    expect(res.status).toBe(200)
    expect(d.buildPriorUrl).not.toHaveBeenCalled()
    const text = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string
    expect(text).toContain('Open API')
    expect(text).toContain('shef-bank-import')
  })

  // ⚠ Отсутствие `client_id` — состояние СЕРВЕРА, а не ошибка нажавшего: инструкция без него
  // приводит владельца счёта к обязательному полю, которое нечем заполнить.
  it('без client_id ⇒ 503 и ничего не отправлено', async () => {
    const d = deps({ alfaClientId: () => '' })
    expect((await handleSendBankInvite(d, alfa)).status).toBe(503)
    expect(d.sendMessage).not.toHaveBeenCalled()
  })

  // У Альфы authorize-потока нет вовсе, значит и проверка «этот банк подключается ключом» к
  // приглашению не применяется — иначе путь был бы мёртв целиком.
  it('ненастроенный Приор не мешает отправить инструкцию Альфы', async () => {
    const d = deps({ priorConfig: () => null })
    expect((await handleSendBankInvite(d, alfa)).status).toBe(200)
  })
})

describe('доставка и запоминание', () => {
  it('чат отказал ⇒ 502, адресат НЕ запоминается', async () => {
    const d = deps({ sendMessage: vi.fn(async () => {
      throw new Error('im down')
    }) })
    const res = await handleSendBankInvite(d, input)
    expect(res.status).toBe(502)
    expect(d.rememberContact).not.toHaveBeenCalled()
  })

  // ⚠ Запоминание — удобство следующего раза. Обратный порядок означал бы «не смогли записать в
  // настройки ⇒ считаем, что не отправили», то есть отказ от главного ради второстепенного.
  it('не удалось запомнить — сообщение всё равно доставлено (200)', async () => {
    const d = deps({ rememberContact: vi.fn(async () => {
      throw new Error('app.option down')
    }) })
    const res = await handleSendBankInvite(d, input)
    expect(res.status).toBe(200)
    expect(d.sendMessage).toHaveBeenCalled()
  })

  it('без имени запоминаем только id', async () => {
    const d = deps()
    await handleSendBankInvite(d, { ...input, userName: '  ' })
    expect(d.rememberContact).toHaveBeenCalledWith(TOKEN, DOMAIN, { userId: '7' })
  })
})
