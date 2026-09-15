import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { defaultPortalSettings } from '~/utils/settings'

// `/app` при провале чтения настроек (#705). Прежде `loaded` поднимался и на отказе запроса, а
// настройки оставались дефолтными — настроенный портал получал вердикт «Приложение не
// настроено», и вдобавок весь рабочий экран прятался. Оба симптома описывают НАШЕ незнание, а
// не состояние портала.

const state = { loadFailed: true }

function mockSettings() {
  vi.doMock('~/composables/useChatSettings', () => ({
    useChatSettings: () => ({
      settings: reactive(defaultPortalSettings()),
      enabled: ref(true),
      loading: ref(false),
      saving: ref(false),
      savedOk: ref(false),
      loaded: ref(true),
      loadFailed: ref(state.loadFailed),
      error: ref(state.loadFailed ? 'Не удалось загрузить настройки' : ''),
      notifyOption: ref(undefined),
      errorOption: ref(undefined),
      chatFetcher: async () => ({ items: [], hasMore: false }),
      load: async () => {},
      save: async () => {}
    })
  }))
}

// В портале, рабочим экраном (не лаунчер): у фрейма есть НАШ `place`.
vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return { useB24: () => makeMockB24({ isInit: () => true, sliderMode: true }) }
})

async function mountApp() {
  mockSettings()
  const AppPage = (await import('~/pages/app.vue')).default
  const wrapper = await mountSuspended(AppPage, { route: '/app' })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  vi.doUnmock('~/composables/useChatSettings')
  vi.resetModules()
  state.loadFailed = true
})

describe('/app: настройки прочитать не удалось (#705)', () => {
  it('говорит об отказе чтения, а не «приложение не настроено»', async () => {
    const wrapper = await mountApp()
    expect(wrapper.find('[data-testid="settings-load-failed"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Приложение не настроено')
    expect(wrapper.text()).not.toContain('Администратор портала завершает настройку')
  })

  it('ГАРД: рабочий экран не прячется', async () => {
    // Мутация «считать провал чтения ненастроенным порталом» вернула бы вердикт и увела бы
    // список операций со сводкой с экрана — это и есть проверяемое здесь.
    const wrapper = await mountApp()
    expect(wrapper.text()).toContain('Последние операции')
  })

  it('прочитанные настройки ненастроенного портала по-прежнему дают вердикт', async () => {
    // Иначе починка проглотила бы настоящий случай «чат не выбран».
    state.loadFailed = false
    const wrapper = await mountApp()
    expect(wrapper.find('[data-testid="settings-load-failed"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Приложение не настроено')
  })
})
