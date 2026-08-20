import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLIDER_INTENT_KEY, encodeSliderIntent } from '~/utils/sliderIntent'

// Мидлвар, уводящий свежий фрейм слайдера на нужный маршрут (#528). Логика простая, но
// проверить её больше нечем: у портала фрейм один, повторить руками нельзя, а ошибка здесь
// выглядит как «кнопка молча ничего не делает».

const state = vi.hoisted(() => ({ place: undefined as string | undefined, initCalls: 0 }))
const navigateSpy = vi.hoisted(() => vi.fn(async () => 'navigated'))

// Чистое ядро метки — не мокаем: её поведение (TTL, разбор) и есть предмет проверки.

vi.mock('~/composables/useB24', () => ({
  useB24: () => ({
    init: async () => {
      state.initCalls += 1
    },
    placementPlace: () => state.place
  })
}))

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
  state.place = undefined
  state.initCalls = 0
  window.sessionStorage.clear()
})

describe('мидлвар слайдера', () => {
  it('уводит фрейм, открытый с place=app-options, на /settings', async () => {
    state.place = 'app-options'
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith('/settings')
  })

  it('уводит фрейм, открытый с place=app-import, на /import', async () => {
    state.place = 'app-import'
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
    state.place = 'app-options'
    await runMiddleware('/app')
    expect(state.initCalls).toBe(1)
  })
})

describe('мидлвар слайдера: портал не донёс place (#537)', () => {
  it('ведёт по нашей метке, когда place пуст', async () => {
    // Живой прогон: слайдер открывается, но приходит без нашего `place`, и человек видит в нём
    // главный экран — кнопка выглядит сломанной, хотя сработала.
    window.sessionStorage.setItem(SLIDER_INTENT_KEY, encodeSliderIntent('app-options', Date.now()))
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith('/settings')
  })

  it('метка старше окна не уводит никуда', async () => {
    // Иначе она пережила бы слайдер и утащила бы в настройки обычный вход в приложение.
    window.sessionStorage.setItem(SLIDER_INTENT_KEY, encodeSliderIntent('app-options', Date.now() - 60_000))
    await runMiddleware('/app')
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('метка снимается ДАЖЕ когда place пришёл — она не должна пережить свой фрейм', async () => {
    state.place = 'app-import'
    window.sessionStorage.setItem(SLIDER_INTENT_KEY, encodeSliderIntent('app-options', Date.now()))
    await runMiddleware('/app')
    expect(navigateSpy).toHaveBeenCalledWith('/import') // place главнее метки
    expect(window.sessionStorage.getItem(SLIDER_INTENT_KEY)).toBeNull()
  })
})
