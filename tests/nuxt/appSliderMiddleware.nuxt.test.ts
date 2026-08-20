import { afterEach, describe, expect, it, vi } from 'vitest'

// Мидлвар, уводящий свежий фрейм слайдера на нужный маршрут (#528). Логика простая, но
// проверить её больше нечем: у портала фрейм один, повторить руками нельзя, а ошибка здесь
// выглядит как «кнопка молча ничего не делает».

// `options` — то, что «прислал портал»; `placementPlace` берём НАСТОЯЩИЙ, потому что вся суть
// проверки в том, как читается присланное.
const state = vi.hoisted(() => ({ options: undefined as unknown, initCalls: 0 }))
const navigateSpy = vi.hoisted(() => vi.fn(async () => 'navigated'))

vi.mock('~/composables/useB24', async () => {
  const { placeFromOptions } = await import('~/utils/placementOptions')
  return {
    useB24: () => ({
      init: async () => {
        state.initCalls += 1
      },
      get: () => ({ placement: { options: state.options, isSliderMode: true } }),
      placementPlace: () => placeFromOptions(state.options)
    })
  }
})

vi.mock('#app/composables/router', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  return { ...actual, navigateTo: navigateSpy }
})

async function runMiddleware(path: string) {
  vi.resetModules()
  const mw = (await import('~/middleware/01.appSlider.global')).default as unknown as
    (to: { path: string }, from: { path: string }) => Promise<unknown>
  return mw({ path }, { path })
}

afterEach(() => {
  navigateSpy.mockClear()
  state.options = undefined
  state.initCalls = 0
})

describe('мидлвар слайдера', () => {
  it('уводит фрейм, открытый с place=app-options, на /settings', async () => {
    state.options = { place: 'app-options' }
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith('/settings')
  })

  it('уводит фрейм, открытый с place=app-import, на /import', async () => {
    state.options = { place: 'app-import' }
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith('/import')
  })

  it('обычное открытие приложения (без place) никуда не уводит', async () => {
    await runMiddleware('/app')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('дожидается рукопожатия с порталом ДО чтения place', async () => {
    // Иначе решение принимается на пустом `placement`, и слайдер остаётся на /app —
    // снаружи это выглядит как «настройки не открываются».
    state.options = { place: 'app-options' }
    await runMiddleware('/app')
    expect(state.initCalls).toBe(1)
  })
})

describe('мидлвар слайдера: форма PLACEMENT_OPTIONS (#537)', () => {
  it('уводит, когда портал прислал параметры JSON-СТРОКОЙ', async () => {
    // Живой симптом: слайдер открывался и показывал главный экран. Параметр доезжал, но читался
    // как `options.place` у объекта — у строки это молча `undefined`, и вести фрейм было не по чему.
    state.options = JSON.stringify({ place: 'app-options' })
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith('/settings')
  })

  it('уводит, когда ключ пришёл заглавными', async () => {
    // Остальные поля init-данных портал шлёт именно так (PLACEMENT, LANG, IS_ADMIN).
    state.options = { PLACE: 'app-import' }
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith('/import')
  })
})
