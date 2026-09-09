import { describe, expect, it } from 'vitest'
import { frameFetchError } from '~/composables/useFrameAuth'

// ⚠ Проект `nuxt`, а не `unit`: модуль тянет `~/composables/useB24` (алиас Nuxt), хотя сама
// проверяемая функция чистая.

describe('frameFetchError', () => {
  it('берёт текст роута, когда он есть', () => {
    expect(frameFetchError({ data: { error: 'portal not installed' } }, 'Не удалось'))
      .toBe('Не удалось: portal not installed')
  })

  it('без тела — только запасной текст', () => {
    expect(frameFetchError(new Error('boom'), 'Не удалось')).toBe('Не удалось')
  })

  // ⚠ ЖИВАЯ НАХОДКА 2026-09-09. Админ несколько раз подряд открыл настройки, выбрал лимит зоны
  // nginx — и СРАЗУ ТРИ блока (список подключений, сверка счетов, экран готовности) сказали
  // «Не удалось загрузить …» без единого слова о причине. Вывод, который он сделал, был
  // естественным и неверным: «пропало подключение к Приору». Оно никуда не пропадало.
  // ⚠ Тела с `error` у 429 нет и быть не может: его отдаёт nginx, а не наш роут, — поэтому общая
  // ветка «нет тела ⇒ запасной текст» накрывала ровно тот случай, где причина известна точно.
  it.each([['status', { status: 429 }], ['statusCode', { statusCode: 429 }]])(
    'называет 429 своими словами (%s)', (_n, e) => {
      const msg = frameFetchError(e, 'Не удалось загрузить список подключений')
      expect(msg).toContain('Не удалось загрузить список подключений')
      expect(msg).toMatch(/слишком много запросов/i)
      expect(msg).toMatch(/подождите/i)
    }
  )

  it('другой код ответа под эту ветку НЕ попадает', () => {
    expect(frameFetchError({ status: 500 }, 'Не удалось')).toBe('Не удалось')
    expect(frameFetchError({ status: 403, data: { error: 'admin required' } }, 'Не удалось'))
      .toBe('Не удалось: admin required')
  })
})
