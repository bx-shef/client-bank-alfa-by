import { describe, expect, it } from 'vitest'
import { pausePollErrorMessage } from '~/utils/pausePollError'

// Отдельный модуль сообщений заведён по той же причине, что `disconnectError`/`setAccountError`:
// `frameFetchError` подклеил бы английский текст сервера, а среди исходов есть советы, ради
// которых сообщение и читают.

const err = (statusCode: number) => ({ statusCode })

describe('pausePollErrorMessage', () => {
  it('404 и 409 говорят РАЗНОЕ — их нельзя слить', () => {
    // ⚠ 409 — «строка изменилась под вами»: подключение живо, список надо обновить.
    // 404 — подключения больше нет вовсе: обновление покажет пустое место, ставить на паузу нечего.
    // Один текст на оба случая отправил бы человека обновлять список ради строки, которой нет.
    expect(pausePollErrorMessage(err(409), true)).toContain('Список устарел')
    expect(pausePollErrorMessage(err(404), true)).toContain('уже отключено')
    expect(pausePollErrorMessage(err(409), true)).not.toBe(pausePollErrorMessage(err(404), true))
  })

  it('403 называет причину, а не «ошибку»', () => {
    expect(pausePollErrorMessage(err(403), true)).toContain('администратор')
  })

  it('текст следует НАПРАВЛЕНИЮ действия', () => {
    // «Не удалось возобновить опрос» при попытке возобновить, а не универсальное «не удалось».
    expect(pausePollErrorMessage(err(400), true)).toContain('приостановить')
    expect(pausePollErrorMessage(err(400), false)).toContain('возобновить')
    expect(pausePollErrorMessage(new Error('network'), false)).toContain('возобновить')
  })

  it('неизвестный отказ не оставляет человека без текста', () => {
    expect(pausePollErrorMessage(null, true).length).toBeGreaterThan(0)
    expect(pausePollErrorMessage(undefined, true).length).toBeGreaterThan(0)
  })
})
