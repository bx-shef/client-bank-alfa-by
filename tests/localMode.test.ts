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

  it('не-строка — обычный режим (fail-safe)', () => {
    expect(isLocalMode(undefined)).toBe(false)
    expect(isLocalMode(null)).toBe(false)
    expect(isLocalMode(1)).toBe(false)
    expect(isLocalMode(true)).toBe(false)
  })
})
