import { describe, expect, it } from 'vitest'
import {
  FRAME_PULSE_MAX_MS, FRAME_PULSE_MIN_MS, FRAME_REFRESH_MARGIN_MS,
  frameTokenDelayMs, frameTokenDue
} from '../app/utils/frameTokenPulse'

// Гард продления токена фрейма (живая находка владельца 2026-09-10: вкладка настроек повисела без
// действий, и три блока разом сказали «invalid frame token for this portal»).

const NOW = 1_700_000_000_000
const sec = (ms: number): number => ms / 1000

describe('когда продлевать токен фрейма', () => {
  it('свежий токен не трогаем', () => {
    expect(frameTokenDue(sec(NOW + 60 * 60_000), NOW)).toBe(false)
  })

  it('в пределах запаса — пора', () => {
    expect(frameTokenDue(sec(NOW + FRAME_REFRESH_MARGIN_MS - 1), NOW)).toBe(true)
  })

  // ⚠ Продлеваем РАНЬШЕ конца срока, а не по факту отказа. У SDK порог — `getAuthData() === false`,
  // то есть срок УЖЕ вышел; дыра между этим мгновением и ближайшим фоновым опросом и наблюдалась.
  it('запас есть, и он не нулевой — иначе мы копируем поведение SDK, а не чиним его', () => {
    expect(FRAME_REFRESH_MARGIN_MS).toBeGreaterThan(60_000)
    expect(frameTokenDue(sec(NOW + FRAME_REFRESH_MARGIN_MS + 60_000), NOW)).toBe(false)
  })

  // ⚠ Неизвестный срок — ДА. Цена несимметрична: лишнее продление это один `postMessage`,
  // пропущенное — экран «не удалось» у человека, который ничего не делал.
  it('срок неизвестен ⇒ продлеваем', () => {
    for (const v of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(frameTokenDue(v as number | undefined, NOW), `expires=${String(v)}`).toBe(true)
    }
  })
})

describe('через сколько проснуться', () => {
  it('целимся в «конец срока минус запас», а не будим себя каждую минуту', () => {
    const left = 12 * 60_000
    expect(frameTokenDelayMs(sec(NOW + left), NOW)).toBe(left - FRAME_REFRESH_MARGIN_MS)
  })

  // ⚠ Потолок держит и ЧАСОВОЙ токен — то есть обычный. Спать до самого срока было бы соблазнительно
  // (одно пробуждение в час), но таймер переживает и сон машины, и перевод часов, а стоит проверка
  // одного синхронного чтения из SDK — ни запроса, ни `postMessage`.
  it('длинный срок упирается в потолок, короткий — в пол', () => {
    expect(frameTokenDelayMs(sec(NOW + 60 * 60_000), NOW)).toBe(FRAME_PULSE_MAX_MS)
    expect(frameTokenDelayMs(sec(NOW + 10 * 60 * 60_000), NOW)).toBe(FRAME_PULSE_MAX_MS)
    expect(frameTokenDelayMs(sec(NOW + 1000), NOW)).toBe(FRAME_PULSE_MIN_MS)
  })

  it('срок неизвестен ⇒ минимальная пауза', () => {
    expect(frameTokenDelayMs(undefined, NOW)).toBe(FRAME_PULSE_MIN_MS)
  })
})
