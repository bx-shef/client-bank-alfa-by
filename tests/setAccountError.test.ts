import { describe, expect, it } from 'vitest'
import { setAccountErrorMessage, setAccountErrorStatus } from '../app/utils/setAccountError'

// Сообщение админу при неудачном назначении счёта (#509).
//
// Раньше к русской подводке подклеивался английский текст сервера. Пока исходов было два и оба
// означали тупик, это было терпимо. Теперь есть третий — «занято, повторите», — и он единственный,
// ради которого сообщение читают: он говорит, что делать дальше.

describe('setAccountErrorStatus', () => {
  it('понимает обе формы ошибки — FetchError и axios-подобную', () => {
    expect(setAccountErrorStatus({ statusCode: 503 })).toBe(503)
    expect(setAccountErrorStatus({ response: { status: 409 } })).toBe(409)
    // Приоритет за `statusCode`, как в `loginError.ts` — форма у ошибок разная, правило одно.
    expect(setAccountErrorStatus({ statusCode: 503, response: { status: 409 } })).toBe(503)
    expect(setAccountErrorStatus(new Error('network'))).toBeUndefined()
    expect(setAccountErrorStatus(null)).toBeUndefined()
  })
})

describe('setAccountErrorMessage', () => {
  it('на 503 зовёт ПОВТОРИТЬ, а не сообщает о поломке', () => {
    const msg = setAccountErrorMessage({ statusCode: 503 })
    expect(msg).toContain('повторите')
    // Оно временное — назвать это ошибкой значит отправить админа искать несуществующую причину.
    expect(msg).not.toContain('Не удалось')
  })

  it('на 409 предлагает ДРУГОЙ номер, а не повтор', () => {
    const msg = setAccountErrorMessage({ statusCode: 409 })
    expect(msg).toContain('уже подключён')
    expect(msg).not.toContain('повторите')
  })

  it('различает все исходы между собой', () => {
    // Иначе разные причины читались бы как одна, и человек чинил бы не то.
    const msgs = [503, 409, 404, 403, undefined].map(s => setAccountErrorMessage(s ? { statusCode: s } : new Error('x')))
    expect(new Set(msgs).size).toBe(msgs.length)
  })

  it('говорит по-русски и не тащит текст сервера наружу', () => {
    // Тексты сервера английские (`this account is already connected`) — именно от них и уходили.
    for (const status of [503, 409, 404, 403]) {
      const msg = setAccountErrorMessage({ statusCode: status })
      expect(msg).toMatch(/[а-яё]/i)
      expect(msg).not.toMatch(/[a-z]{4,}/i)
    }
  })
})
