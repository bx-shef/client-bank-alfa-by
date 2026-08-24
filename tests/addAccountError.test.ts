import { describe, expect, it } from 'vitest'
import { addAccountErrorMessage, addAccountErrorStatus } from '../app/utils/addAccountError'

// ⚠ Смысл набора: ТРИ разных отказа отвечают одним статусом 409, и каждый требует своего действия.
// Слитый текст отправил бы человека не туда в двух случаях из трёх — а один из этих случаев стоит
// похода ВЛАДЕЛЬЦА СЧЁТА в интернет-банк.

describe('addAccountErrorMessage (#23)', () => {
  const err = (statusCode: number, error?: string) => ({ statusCode, data: error ? { error } : undefined })

  it('читает статус из обеих форм ошибки', () => {
    expect(addAccountErrorStatus({ statusCode: 409 })).toBe(409)
    expect(addAccountErrorStatus({ response: { status: 403 } })).toBe(403)
    expect(addAccountErrorStatus(null)).toBeUndefined()
  })

  it('три разных 409 дают ТРИ разных совета', () => {
    const taken = addAccountErrorMessage(err(409, 'this account is already connected'))
    const stale = addAccountErrorMessage(err(409, 'the list is out of date, refresh it'))
    const old = addAccountErrorMessage(err(409, 'this connection predates multi-account support, reconnect it first'))
    expect(new Set([taken, stale, old]).size).toBe(3)
    expect(old).toContain('заново')
    expect(stale).toContain('обновите')
    expect(taken).toContain('другой номер')
  })

  it('незавершённое подключение отправляет выбрать счёт, а не переподключать', () => {
    expect(addAccountErrorMessage(err(409, 'choose the account of this connection first')))
      .toContain('счёт самого подключения')
  })

  it('остальные статусы — свои тексты, а не общая заглушка', () => {
    const texts = [403, 404, 400].map(s => addAccountErrorMessage(err(s)))
    expect(new Set(texts).size).toBe(3)
    expect(texts.every(t => t !== addAccountErrorMessage(err(500)))).toBe(true)
  })

  it('неизвестный отказ не молчит', () => {
    expect(addAccountErrorMessage(new Error('boom'))).toBeTruthy()
  })
})
