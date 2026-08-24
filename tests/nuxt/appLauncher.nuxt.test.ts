import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { APP_SLIDER_PLACE_MAIN } from '~/config/b24'

// Пусковая страница главного экрана (#15). Приложение, открытое БАЗОВЫМ фреймом (прямая ссылка,
// пункт левого меню), открывает главную слайдером и само не поднимает рабочий экран — иначе опрос
// статуса, чтение настроек и pull крутились бы в двух фреймах разом.
//
// ⚠ Проверяется именно ветка лаунчера, поэтому мок — В ФРЕЙМЕ, БЕЗ нашего `place` и НЕ слайдер, и
// маршрут БЕЗ `?preview=1` (превью — дев-обход, оно форсит рабочий экран).

const openSlider = vi.hoisted(() => vi.fn(async () => true))
const state = vi.hoisted(() => ({ sliderMode: false, place: undefined as string | undefined }))

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return {
    useB24: () => makeMockB24({
      openAppSlider: openSlider,
      sliderMode: state.sliderMode,
      placementOptions: state.place ? { place: state.place } : {}
    })
  }
})

afterEach(() => {
  openSlider.mockClear()
  openSlider.mockImplementation(async () => true)
  state.sliderMode = false
  state.place = undefined
  try {
    window.sessionStorage?.clear()
  } catch { /* приватный режим */ }
})

const mount = async () => mountSuspended(await import('~/pages/app.vue').then(m => m.default), { route: '/app' })

describe('#15 пусковая страница главного экрана', () => {
  it('базовый фрейм автоматически открывает главную слайдером', async () => {
    const wrapper = await mount()
    await flushPromises()
    expect(openSlider).toHaveBeenCalledWith(APP_SLIDER_PLACE_MAIN, expect.objectContaining({ width: expect.any(Number) }))
    // И показывает пусковой экран с путём обратно, а не рабочий список.
    expect(wrapper.find('[data-testid="app-launcher"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Последние операции')
  })

  it('слайдер, открытый НАМИ (есть наш place), рабочий экран НЕ прячет', async () => {
    // Иначе слайдер, который сам и есть главная, показал бы пусковую страницу вместо работы.
    state.place = APP_SLIDER_PLACE_MAIN
    const wrapper = await mount()
    await flushPromises()
    expect(openSlider).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="app-launcher"]').exists()).toBe(false)
  })

  it('слайдер по SDK-признаку (без нашего place) тоже работает как рабочий экран', async () => {
    // Страховка на случай, если портал откроет нас слайдером без нашего place (#555).
    state.sliderMode = true
    const wrapper = await mount()
    await flushPromises()
    expect(openSlider).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="app-launcher"]').exists()).toBe(false)
  })

  it('кнопка «Открыть выписки» открывает слайдер повторно', async () => {
    const wrapper = await mount()
    await flushPromises()
    openSlider.mockClear()
    const btn = wrapper.find('[data-testid="app-launcher-open"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    await flushPromises()
    expect(openSlider).toHaveBeenCalledWith(APP_SLIDER_PLACE_MAIN, expect.anything())
  })

  it('портал отказал в слайдере — падаем в рабочий экран, а не в мёртвую страницу', async () => {
    openSlider.mockImplementation(async () => false)
    const wrapper = await mount()
    await flushPromises()
    // Слайдер пробовали открыть (лаунчер), но получили отказ — не остаёмся на пусковой странице.
    expect(openSlider).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="app-launcher"]').exists()).toBe(false)
  })

  it('повторная загрузка в том же табе НЕ открывает слайдер снова (страховка от цикла)', async () => {
    // ⚠ Живой портал уже присылал фрейму слайдера пустой PLACEMENT_OPTIONS (#555): без отметки
    // лаунчер открыл бы слайдер, тот счёл бы себя базовым фреймом и открыл следующий — без предела.
    const first = await mount()
    await flushPromises()
    expect(openSlider).toHaveBeenCalledTimes(1)
    first.unmount()
    openSlider.mockClear()
    await mount()
    await flushPromises()
    expect(openSlider).not.toHaveBeenCalled()
  })
})
