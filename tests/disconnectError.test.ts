import { describe, expect, it } from 'vitest'
import { disconnectErrorMessage, disconnectErrorStatus } from '../app/utils/disconnectError'

// Сообщение админу, когда не удалось отключить подключение банка (#517).
//
// Появилось вместе с исходом «список устарел»: именно ради него сообщение и читают — оно говорит,
// что делать дальше. На английском (как подклеивал `frameFetchError`) совет бесполезен.

describe('disconnectErrorStatus', () => {
  it('понимает обе формы ошибки', () => {
    expect(disconnectErrorStatus({ statusCode: 409 })).toBe(409)
    expect(disconnectErrorStatus({ response: { status: 403 } })).toBe(403)
    expect(disconnectErrorStatus({ statusCode: 409, response: { status: 403 } })).toBe(409)
    expect(disconnectErrorStatus(new Error('network'))).toBeUndefined()
    expect(disconnectErrorStatus(null)).toBeUndefined()
  })
})

describe('disconnectErrorMessage', () => {
  it('на 409 зовёт ОБНОВИТЬ СПИСОК, а не менять действия', () => {
    // ⚠ Здесь 409 значит «строка изменилась под вами», а не «так не будет никогда»: пока список
    // висел на экране, подключению назначили счёт, и оно перестало быть тем, что убирали.
    const msg = disconnectErrorMessage({ statusCode: 409 })
    expect(msg).toContain('Обновите список')
    expect(msg).toContain('устарел')
  })

  it('различает все исходы между собой', () => {
    const msgs = [409, 403, 400, undefined].map(s => disconnectErrorMessage(s ? { statusCode: s } : new Error('x')))
    expect(new Set(msgs).size).toBe(msgs.length)
  })

  it('говорит по-русски и не тащит текст сервера наружу', () => {
    for (const status of [409, 403, 400]) {
      const msg = disconnectErrorMessage({ statusCode: status })
      expect(msg).toMatch(/[а-яё]/i)
      expect(msg).not.toMatch(/[a-z]{4,}/i)
    }
  })
})
