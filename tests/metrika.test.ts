import { describe, expect, it } from 'vitest'
import { DEFAULT_METRIKA_ID, resolveMetrikaId } from '~/utils/metrika'

// По этой функции `nuxt.config.ts` вставляет сниппет Метрики, а `useMetrikaGoal` шлёт цели. Пока
// цели читали конфиг напрямую, пустая переменная сборки обнуляла id, и с #701 цели не уходили —
// при работающем счётчике (замерено на проде 2026-09-27).

describe('resolveMetrikaId', () => {
  it('пусто вне локального режима — наш счётчик', () => {
    for (const v of ['', '  ', undefined, null]) {
      expect(resolveMetrikaId(v, false), JSON.stringify(v)).toBe(DEFAULT_METRIKA_ID)
    }
  })

  it('пусто в локальном режиме — счётчика нет: трафик клона не уходит в нашу аналитику', () => {
    for (const v of ['', '  ', undefined, null]) {
      expect(resolveMetrikaId(v, true), JSON.stringify(v)).toBe('')
    }
  })

  it('заданный id берётся и в локальном режиме: свой счётчик клон ставит сам', () => {
    expect(resolveMetrikaId('12345', true)).toBe('12345')
    expect(resolveMetrikaId('12345', false)).toBe('12345')
  })

  it('число из destr — тот же id', () => {
    expect(resolveMetrikaId(12345, false)).toBe('12345')
  })

  it('только цифры; нецифровое значение выключает счётчик явно', () => {
    expect(resolveMetrikaId(' 12-345 ', false)).toBe('12345')
    expect(resolveMetrikaId('off', false)).toBe('')
  })
})
