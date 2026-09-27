import { afterEach, describe, expect, it } from 'vitest'
import { bankConnectConfigFromEnv } from '../server/utils/bankConnectStart'

// Конфигурация Альфы из переменных окружения.
//
// ⚠ Проверки самого `handleBankConnectStart` отсюда УБРАНЫ вместе с ним: самостоятельное
// подключение банка администратором снято (решение владельца 2026-09-17), остался единственный
// путь — отправить инструкцию владельцу счёта. Гейты (админ, установка портала, «моя компания»)
// и выпуск authorize-ссылки Приора проверяются там, где они теперь живут, —
// `tests/bankInviteSend.test.ts`.

describe('bankConnectConfigFromEnv', () => {
  const KEYS = ['ALFA_OAUTH_CLIENT_ID', 'ALFA_OAUTH_TOKEN_URL', 'ALFA_OAUTH_REDIRECT_URI', 'ALFA_OAUTH_SCOPE']
  afterEach(() => KEYS.forEach(k => Reflect.deleteProperty(process.env, k)))

  it('null until client_id + token_url are both set', () => {
    expect(bankConnectConfigFromEnv('alfa-by')).toBeNull()
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    expect(bankConnectConfigFromEnv('alfa-by')).toBeNull() // still missing token url
    process.env.ALFA_OAUTH_TOKEN_URL = 'https://alfa:8273/token'
    expect(bankConnectConfigFromEnv('alfa-by')).toEqual({ baseUrl: 'https://alfa:8273', clientId: 'CID' })
  })

  // ⚠ Адрес возврата БОЛЬШЕ НЕ ТРЕБУЕТСЯ (#488): он существовал только ради authorize-редиректа
  // Альфы, которого не осталось. Останься он обязательным — стенд, где переменную не задали,
  // отвечал бы «провайдер недоступен» на подключение ПО КЛЮЧУ, к которому адрес возврата
  // отношения не имеет. Мутация «вернуть проверку» валит этот тест.
  it('НЕ требует ALFA_OAUTH_REDIRECT_URI и не возвращает его', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    process.env.ALFA_OAUTH_TOKEN_URL = 'https://alfa:8273/token'
    process.env.ALFA_OAUTH_REDIRECT_URI = 'https://app/cb'
    expect(bankConnectConfigFromEnv('alfa-by')).toEqual({ baseUrl: 'https://alfa:8273', clientId: 'CID' })
  })

  it('derives the token host by stripping /token; picks up optional scope', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    process.env.ALFA_OAUTH_TOKEN_URL = 'https://alfa:8273/token/'
    process.env.ALFA_OAUTH_SCOPE = 'accounts payments'
    expect(bankConnectConfigFromEnv('alfa-by')).toEqual({
      baseUrl: 'https://alfa:8273', clientId: 'CID', scope: 'accounts payments'
    })
  })
  it('null when TOKEN_URL does not end in /token (cannot derive the host)', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    process.env.ALFA_OAUTH_TOKEN_URL = 'https://alfa:8273/oauth2'
    expect(bankConnectConfigFromEnv('alfa-by')).toBeNull()
  })
  it('prior-by / manual → null (Prior has its own config/flow; manual has no OAuth)', () => {
    expect(bankConnectConfigFromEnv('prior-by')).toBeNull()
    expect(bankConnectConfigFromEnv('manual')).toBeNull()
  })

  // ⚠ Схема адреса — то же правило, что у продления (`bankCredsFromEnv` → `normalizeBankApiBase`).
  // Прежняя регулярка пропускала `http://` на ПУБЛИЧНЫЙ хост: обмен ключа отправил бы бессрочный
  // ключ API и `client_secret` открытым текстом. Мутация «вернуть регулярку» валит этот тест.
  it('http:// на публичный хост — отказ: ключ API не уходит открытым текстом', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    process.env.ALFA_OAUTH_TOKEN_URL = 'http://developerhub.alfabank.by:8273/token'
    expect(bankConnectConfigFromEnv('alfa-by')).toBeNull()
  })

  // Обратная сторона той же регулярки: `HTTPS://` продление принимало, а подключение ключом
  // отвечало «не настроено» при заданных переменных (#770).
  it('схема в верхнем регистре принимается — как у продления', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    process.env.ALFA_OAUTH_TOKEN_URL = 'HTTPS://alfa:8273/token'
    expect(bankConnectConfigFromEnv('alfa-by')).toEqual({ baseUrl: 'HTTPS://alfa:8273', clientId: 'CID' })
  })

  it('http:// на внутренний адрес допустим — правило то же, что у всех банковских адресов', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    process.env.ALFA_OAUTH_TOKEN_URL = 'http://localhost:8273/token'
    expect(bankConnectConfigFromEnv('alfa-by')).toEqual({ baseUrl: 'http://localhost:8273', clientId: 'CID' })
  })

  // `URL` разбирает `https:///token` как хост `token`, то есть правило адреса его пропускает;
  // без отдельной проверки хоста обмен ушёл бы на `https:///token`.
  it('адрес без хоста — отказ', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'CID'
    process.env.ALFA_OAUTH_TOKEN_URL = 'https:///token'
    expect(bankConnectConfigFromEnv('alfa-by')).toBeNull()
    process.env.ALFA_OAUTH_TOKEN_URL = '/token'
    expect(bankConnectConfigFromEnv('alfa-by')).toBeNull()
  })
})
