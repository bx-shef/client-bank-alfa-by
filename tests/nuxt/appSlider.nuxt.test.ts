import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { APP_SLIDER_PLACE_IMPORT, APP_SLIDER_PLACE_SETTINGS } from '~/config/b24'

// Вторичные экраны (настройки, ручная загрузка) открываются НАСТОЯЩИМ слайдером портала
// `openSliderAppPage({ place })`, а не нашим `B24Slideover`. Здесь проверяется ровно проводка:
// каким `place` открывается экран и что происходит, когда портал отказал.
//
// ⚠ Фолбэк — не украшение. Вне портала слайдера нет вовсе, а внутри портал может отказать во
// вложенном слайдере; без перехода обычной навигацией кнопка молча ничего бы не делала.

const openSlider = vi.hoisted(() => vi.fn(async () => true))
const navigateSpy = vi.hoisted(() => vi.fn(async () => {}))
const state = vi.hoisted(() => ({ place: undefined as string | undefined }))

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return {
    useB24: () => makeMockB24({
      openAppSlider: openSlider,
      placementOptions: state.place ? { place: state.place } : {}
    })
  }
})

vi.mock('#app/composables/router', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  return { ...actual, navigateTo: navigateSpy }
})

afterEach(() => {
  openSlider.mockClear()
  openSlider.mockImplementation(async () => true)
  navigateSpy.mockClear()
  state.place = undefined
})

const PREVIEW = { route: '/app?preview=1' }

describe('открытие вторичных экранов слайдером портала', () => {
  it('«Настройки» открывают слайдер с place=app-options, а не рисуют панель внутри страницы', async () => {
    const wrapper = await mountSuspended(await import('~/pages/app.vue').then(m => m.default), PREVIEW)
    await flushPromises()
    const button = wrapper.findAll('button').find(b => b.text().includes('Настройки'))
    expect(button, 'кнопка настроек должна быть на странице').toBeTruthy()
    await button!.trigger('click')
    await flushPromises()
    expect(openSlider).toHaveBeenCalledWith(APP_SLIDER_PLACE_SETTINGS, expect.objectContaining({ width: expect.any(Number) }))
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('«Загрузить выписку» открывает слайдер с place=app-import', async () => {
    const wrapper = await mountSuspended(await import('~/pages/app.vue').then(m => m.default), PREVIEW)
    await flushPromises()
    const button = wrapper.findAll('button').find(b => b.text().includes('Загрузить выписку'))
    expect(button, 'кнопка загрузки должна быть на странице').toBeTruthy()
    await button!.trigger('click')
    await flushPromises()
    expect(openSlider).toHaveBeenCalledWith(APP_SLIDER_PLACE_IMPORT, expect.objectContaining({ width: expect.any(Number) }))
  })

  it('портал отказал в слайдере — уходим обычной навигацией, экран всё равно открывается', async () => {
    openSlider.mockImplementation(async () => false)
    const wrapper = await mountSuspended(await import('~/pages/app.vue').then(m => m.default), PREVIEW)
    await flushPromises()
    const button = wrapper.findAll('button').find(b => b.text().includes('Настройки'))
    await button!.trigger('click')
    await flushPromises()
    expect(navigateSpy).toHaveBeenCalledWith('/settings')
  })

  it('ширина слайдера не уходит под брейкпоинт sm — иначе десктоп молча получит мобильную вёрстку', async () => {
    const wrapper = await mountSuspended(await import('~/pages/app.vue').then(m => m.default), PREVIEW)
    await flushPromises()
    const button = wrapper.findAll('button').find(b => b.text().includes('Настройки'))
    await button!.trigger('click')
    await flushPromises()
    const args = openSlider.mock.calls[0] as unknown as [string, { width: number }] | undefined
    const width = args?.[1]?.width ?? 0
    expect(width).toBeGreaterThanOrEqual(640)
  })
})

describe('экран, открытый слайдером, знает об этом', () => {
  it('/import в слайдере предлагает «Закрыть», а не «К сводке операций»', async () => {
    state.place = APP_SLIDER_PLACE_IMPORT
    const wrapper = await mountSuspended(await import('~/pages/import.vue').then(m => m.default), { route: '/import?preview=1' })
    await flushPromises()
    // За слайдером нет истории: переход на /app открыл бы ВТОРОЕ приложение поверх работы.
    expect(wrapper.text()).toContain('Закрыть')
    expect(wrapper.text()).not.toContain('К сводке операций')
  })

  it('/import обычной страницей оставляет «К сводке операций»', async () => {
    const wrapper = await mountSuspended(await import('~/pages/import.vue').then(m => m.default), { route: '/import?preview=1' })
    await flushPromises()
    expect(wrapper.text()).toContain('К сводке операций')
  })
})
