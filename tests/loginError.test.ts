import { describe, expect, it } from 'vitest'
import { loginErrorMessage, loginErrorStatus } from '../app/utils/loginError'

// Client-side login error mapping (see docs/AUTH.md, #84). login.vue's catch
// block delegates here; asserting it directly avoids the flaky mountSuspended
// unhandled-rejection path. Both error shapes and all three message branches.

describe('loginErrorStatus', () => {
  it('reads a FetchError statusCode', () => {
    expect(loginErrorStatus({ statusCode: 401 })).toBe(401)
    expect(loginErrorStatus({ statusCode: 503 })).toBe(503)
  })
  it('reads an axios-style response.status', () => {
    expect(loginErrorStatus({ response: { status: 401 } })).toBe(401)
  })
  it('prefers statusCode over response.status when both are present', () => {
    expect(loginErrorStatus({ statusCode: 503, response: { status: 401 } })).toBe(503)
  })
  it('returns undefined when neither is present', () => {
    expect(loginErrorStatus({})).toBeUndefined()
    expect(loginErrorStatus(null)).toBeUndefined()
    expect(loginErrorStatus(undefined)).toBeUndefined()
    expect(loginErrorStatus('boom')).toBeUndefined()
    expect(loginErrorStatus(new Error('network'))).toBeUndefined()
  })
})

describe('loginErrorMessage', () => {
  it('503 → "вход не настроен" (no server password)', () => {
    expect(loginErrorMessage({ statusCode: 503 })).toBe('Вход не настроен на сервере (нет пароля).')
    // same via the response.status shape
    expect(loginErrorMessage({ response: { status: 503 } })).toBe('Вход не настроен на сервере (нет пароля).')
  })
  it('401 → "неверный логин или пароль"', () => {
    expect(loginErrorMessage({ statusCode: 401 })).toBe('Неверный логин или пароль.')
    expect(loginErrorMessage({ response: { status: 401 } })).toBe('Неверный логин или пароль.')
  })
  it('any other status or no status → generic retry message', () => {
    const generic = 'Не удалось войти — попробуйте позже.'
    expect(loginErrorMessage({ statusCode: 500 })).toBe(generic)
    expect(loginErrorMessage({ statusCode: 400 })).toBe(generic)
    expect(loginErrorMessage({ response: { status: 500 } })).toBe(generic) // generic via the response.status shape too
    expect(loginErrorMessage({})).toBe(generic)
    expect(loginErrorMessage(new Error('network'))).toBe(generic)
    expect(loginErrorMessage(undefined)).toBe(generic)
  })
})
