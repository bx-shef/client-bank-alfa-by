import { describe, expect, it, vi } from 'vitest'
import { handleReadBankContact } from '../server/utils/bankContactHandler'
import { BANK_CONTACT_KEY } from '../app/utils/bankContact'

// Чтение запомненного адресата подключения банка (#19).

const TOKEN = 'frame-token'
const DOMAIN = 'client.bitrix24.by'

/** `app.option.get` отдаёт ВСЕ ключи приложения — читаем свой из общего конверта. */
function io(over: { admin?: boolean, stored?: unknown, throwOn?: string } = {}) {
  const callRest = vi.fn(async (_host: string, _token: string, method: string) => {
    if (method === over.throwOn) throw new Error('upstream')
    if (method === 'profile') return { result: { ID: '1', ADMIN: over.admin !== false } }
    return { result: { [BANK_CONTACT_KEY]: over.stored } }
  })
  return { io: { callRest }, callRest }
}

describe('гейт', () => {
  it('не-админ ⇒ 403', async () => {
    const { io: i } = io({ admin: false })
    const res = await handleReadBankContact(i, TOKEN, DOMAIN)
    expect(res.status).toBe(403)
  })

  it('без токена/домена ⇒ 400 и ни одного REST', async () => {
    const { io: i, callRest } = io()
    expect((await handleReadBankContact(i, '', DOMAIN)).status).toBe(400)
    expect((await handleReadBankContact(i, TOKEN, '')).status).toBe(400)
    expect(callRest).not.toHaveBeenCalled()
  })

  // Fail-closed: не смогли проверить токен — не отвечаем «адресата нет».
  it('отвергнутый токен ⇒ 502, а не пустой ответ', async () => {
    const { io: i } = io({ throwOn: 'profile' })
    const res = await handleReadBankContact(i, TOKEN, DOMAIN)
    expect(res.status).toBe(502)
    expect(res.body.contact).toBeUndefined()
  })
})

describe('чтение значения', () => {
  it('отдаёт разобранного адресата', async () => {
    const { io: i } = io({ stored: JSON.stringify({ userId: '7', name: 'Иванова А.' }) })
    const res = await handleReadBankContact(i, TOKEN, DOMAIN)
    expect(res.status).toBe(200)
    expect(res.body.contact).toEqual({ userId: '7', name: 'Иванова А.' })
  })

  // ⚠ Мусор и пусто — это «адресата нет», а не поломка: внешне обе ветки дают пустую подпись, но
  // лечатся по-разному, и 502 здесь отправил бы админа искать несуществующий сбой.
  it('пусто и мусор дают contact: null при 200', async () => {
    for (const stored of [undefined, '', 'не json', '{"userId":"abc"}']) {
      const { io: i } = io({ stored })
      const res = await handleReadBankContact(i, TOKEN, DOMAIN)
      expect(res.status, String(stored)).toBe(200)
      expect(res.body.contact, String(stored)).toBeNull()
    }
  })

  it('отказ чтения настроек ⇒ 502', async () => {
    const { io: i } = io({ throwOn: 'app.option.get' })
    expect((await handleReadBankContact(i, TOKEN, DOMAIN)).status).toBe(502)
  })
})
