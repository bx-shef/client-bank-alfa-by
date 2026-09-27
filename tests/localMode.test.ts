import { describe, expect, it } from 'vitest'
import { isLocalMode } from '~/utils/localMode'

// Локальный режим форка (#39). Fail-safe В СТОРОНУ показа брендинга: истинно только явное включение,
// всё сомнительное/пустое/кривое — обычный режим (иначе опечатка молча выпустила бы обезличенный
// билд там, где его не хотели).

describe('isLocalMode', () => {
  it('включается ТОЛЬКО явными значениями (регистр/пробелы не мешают)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ', 'Yes']) {
      expect(isLocalMode(v), `«${v}» должно включать`).toBe(true)
    }
  })

  it('всё прочее — обычный режим', () => {
    for (const v of ['', ' ', '0', 'false', 'no', 'off', 'local', 'да', 'enable', '2']) {
      expect(isLocalMode(v), `«${v}» НЕ должно включать`).toBe(false)
    }
  })

  it('число 1 и булево true — это те же «1» и «true», прошедшие через destr', () => {
    // Сборка разбирает NUXT_PUBLIC_* через destr, и в конфиг `NUXT_PUBLIC_LOCAL_MODE=1` приходит
    // ЧИСЛОМ (замерено 2026-09-27: `localMode:1` в __NUXT__.config). Прежде здесь стояло «1 →
    // обычный режим», и флаг на клоне не делал ничего: наша карточка Маркета и наш счётчик
    // оставались на месте.
    expect(isLocalMode(1)).toBe(true)
    expect(isLocalMode(true)).toBe(true)
  })

  it('прочие не-строки — обычный режим (fail-safe)', () => {
    for (const v of [undefined, null, 0, 2, false, Number.NaN, {}, ['1']]) {
      expect(isLocalMode(v), `${JSON.stringify(v)} НЕ должно включать`).toBe(false)
    }
  })
})
