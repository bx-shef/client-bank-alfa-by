import { describe, expect, it } from 'vitest'
import {
  ALFA_REFRESH_TOKEN_TTL_SEC,
  buildPasswordGrantBody,
  buildRefreshBody,
  isAccessTokenExpired,
  parseTokenResponse
} from '~/utils/alfaOauth'

// ⚠ `redirectUri` в конфигурации БОЛЬШЕ НЕТ: он существовал только ради authorize-редиректа,
// которого у Альфы не осталось (#488). Подключение идёт ключом API, адрес возврата не участвует.
const config = {
  baseUrl: 'https://developerhub.alfabank.by:8273/',
  clientId: 'CID'
}

describe('token request bodies', () => {
  it('собирает тело Password Grant: ключ API в username, scope по умолчанию accounts', () => {
    const body = buildPasswordGrantBody(config, 'API-KEY', 'SECRET')
    expect(body.get('grant_type')).toBe('password')
    expect(body.get('username')).toBe('API-KEY')
    expect(body.get('client_id')).toBe('CID')
    expect(body.get('client_secret')).toBe('SECRET')
    expect(body.get('scope')).toBe('accounts')
    // ⚠ Ни кода, ни адреса возврата: это не authorize-поток, и лишние поля банк вправе отвергнуть.
    expect(body.has('code')).toBe(false)
    expect(body.has('redirect_uri')).toBe(false)
  })

  it('scope можно сузить, но по умолчанию просим МИНИМУМ', () => {
    // Пример банка перечисляет десяток прав, включая подпись документов. Нам нужна выписка.
    expect(buildPasswordGrantBody({ ...config, scope: 'accounts profile' }, 'K', 'S').get('scope'))
      .toBe('accounts profile')
  })
  it('builds the refresh_token body', () => {
    const body = buildRefreshBody(config, 'RT', 'SECRET')
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT')
    expect(body.get('client_id')).toBe('CID')
    expect(body.get('client_secret')).toBe('SECRET')
    // refresh body must NOT carry redirect_uri (per RFC 6749 §6)
    expect(body.has('redirect_uri')).toBe(false)
  })
})

describe('parseTokenResponse', () => {
  it('normalizes a successful token payload', () => {
    const t = parseTokenResponse({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600 })
    expect(t).toEqual({ accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresIn: 3600 })
  })
  it('defaults token_type and expires_in', () => {
    expect(parseTokenResponse({ access_token: 'a', refresh_token: 'r' }))
      .toMatchObject({ tokenType: 'Bearer', expiresIn: 3600 })
  })
  it('throws on an error payload', () => {
    expect(() => parseTokenResponse({ error: 'invalid_grant', error_description: 'bad code' }))
      .toThrow(/invalid_grant — bad code/)
  })
  it('throws when access_token is missing (refresh present)', () => {
    expect(() => parseTokenResponse({ refresh_token: 'r' })).toThrow(/missing access_token\/refresh_token/)
  })
  it('throws when refresh_token is missing (access present)', () => {
    expect(() => parseTokenResponse({ access_token: 'a' })).toThrow(/missing access_token\/refresh_token/)
  })
})

describe('isAccessTokenExpired', () => {
  const issued = 1_000_000
  it('is false well within the lifetime', () => {
    expect(isAccessTokenExpired(issued, 3600, issued + 1000)).toBe(false)
  })
  it('is true within the skew window before expiry', () => {
    // expires at issued + 3_600_000; skew 60_000 → expired from issued + 3_540_000
    expect(isAccessTokenExpired(issued, 3600, issued + 3_540_000)).toBe(true)
  })
  it('is true exactly at the skew boundary (>=)', () => {
    expect(isAccessTokenExpired(issued, 3600, issued + 3_600_000 - 60_000)).toBe(true)
  })
  it('is false one ms before the skew boundary', () => {
    expect(isAccessTokenExpired(issued, 3600, issued + 3_600_000 - 60_000 - 1)).toBe(false)
  })
  it('with skew=0 is true exactly at expiry and after', () => {
    expect(isAccessTokenExpired(issued, 3600, issued + 3_600_000, 0)).toBe(true)
    expect(isAccessTokenExpired(issued, 3600, issued + 3_600_001, 0)).toBe(true)
  })
})

describe('ALFA_REFRESH_TOKEN_TTL_SEC', () => {
  it('matches the documented ~10h value', () => {
    expect(ALFA_REFRESH_TOKEN_TTL_SEC).toBe(36_000)
  })
})
