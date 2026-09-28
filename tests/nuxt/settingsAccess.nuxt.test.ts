import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { defaultPortalSettings } from '~/utils/settings'

// Не-администратор и настройки (#775, блокер релиза). Замечание владельца по живому порталу:
// сотрудник видел кнопку «Настройки», а открыв её — меню разделов и шапку раздела над отказом
// «Настройки доступны только администратору». Меню кликалось, и каждый раздел вёл в тот же отказ.
//
// ⚠ Три случая, и третий несущий: вне портала (`?preview=1`) админа не спросить, а визуальные
// эталоны снимаются именно там — кнопка и меню обязаны остаться.

const portal = { inFrame: true, isAdmin: false, lag: false, hangTitle: false }

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  const { vi: v } = await import('vitest')
  return {
    useB24: () => makeMockB24({
      isInit: () => portal.inFrame,
      isAdmin: portal.isAdmin,
      sliderMode: true,
      isInitLags: portal.lag,
      // Портал, который не отвечает на `setTitle`: промис не завершается никогда.
      ...(portal.hangTitle ? { setTitle: v.fn(() => new Promise(() => {})) } : {})
    })
  }
})

function mockSettings() {
  vi.doMock('~/composables/useChatSettings', () => ({
    useChatSettings: () => ({
      settings: reactive(defaultPortalSettings()),
      enabled: ref(true),
      loading: ref(false),
      saving: ref(false),
      savedOk: ref(false),
      loaded: ref(true),
      loadFailed: ref(false),
      error: ref(''),
      notifyOption: ref(undefined),
      errorOption: ref(undefined),
      chatFetcher: async () => ({ items: [], hasMore: false }),
      load: async () => {},
      save: async () => {}
    })
  }))
}

afterEach(() => {
  vi.doUnmock('~/composables/useChatSettings')
  vi.resetModules()
  portal.inFrame = true
  portal.isAdmin = false
  portal.lag = false
  portal.hangTitle = false
})

async function mountSettings() {
  mockSettings()
  const page = (await import('~/pages/settings.vue')).default
  // Форма — заглушка: здесь проверяется ОБОЛОЧКА страницы, а гейт внутри формы покрыт отдельно.
  const w = await mountSuspended(page, {
    route: '/settings?preview=1',
    global: { stubs: { SettingsForm: { template: '<div data-testid="form-stub" />' } } }
  })
  await flushPromises()
  return w
}

async function mountApp() {
  mockSettings()
  const page = (await import('~/pages/app.vue')).default
  const w = await mountSuspended(page, { route: '/app?preview=1' })
  await flushPromises()
  return w
}

describe('/settings: не-админу — только отказ', () => {
  it('не-админ в портале: ни меню разделов, ни шапки раздела, только отказ', async () => {
    const w = await mountSettings()
    expect(w.find('[data-testid="settings-admin-only"]').exists()).toBe(true)
    expect(w.text()).toContain('Настройки доступны только администратору')
    expect(w.find('[data-testid="settings-nav"]').exists()).toBe(false)
    expect(w.find('[data-testid="section-hint"]').exists()).toBe(false)
    expect(w.find('[data-testid="form-stub"]').exists()).toBe(false)
  })

  it('админ в портале: оболочка с меню, отказа нет', async () => {
    portal.isAdmin = true
    const w = await mountSettings()
    expect(w.find('[data-testid="settings-admin-only"]').exists()).toBe(false)
    expect(w.find('[data-testid="settings-nav"]').exists()).toBe(true)
  })

  it('вне портала (предпросмотр): оболочка с меню остаётся', async () => {
    portal.inFrame = false
    const w = await mountSettings()
    expect(w.find('[data-testid="settings-admin-only"]').exists()).toBe(false)
    expect(w.find('[data-testid="settings-nav"]').exists()).toBe(true)
  })
})

describe('/app: кнопка «Настройки» — только тому, кто может настраивать', () => {
  it('не-админ в портале кнопки не видит', async () => {
    const w = await mountApp()
    expect(w.find('[data-testid="open-settings"]').exists()).toBe(false)
  })

  it('админ в портале кнопку видит', async () => {
    portal.isAdmin = true
    const w = await mountApp()
    expect(w.find('[data-testid="open-settings"]').exists()).toBe(true)
  })

  it('вне портала (предпросмотр) кнопка есть', async () => {
    portal.inFrame = false
    const w = await mountApp()
    expect(w.find('[data-testid="open-settings"]').exists()).toBe(true)
  })
})

// ⚠ Две гонки, найденные ревью #776. Обе возвращали не-админу меню разделов — то есть ровно дефект
// #775, — а тесты выше их не видели: мок отвечал синхронно и сразу.
describe('гонки проверки админа (#775)', () => {
  // Флаг рукопожатия в настоящем `useB24` выставляется в `nextTick`; прочитанный раньше, он
  // объявлял бы портал «снаружи», а снаружи настройки открыты всем.
  it('флаг рукопожатия ещё не выставлен — не-админ всё равно получает отказ', async () => {
    portal.lag = true
    const w = await mountSettings()
    expect(w.find('[data-testid="settings-admin-only"]').exists()).toBe(true)
    expect(w.find('[data-testid="settings-nav"]').exists()).toBe(false)
  })

  it('флаг рукопожатия ещё не выставлен — кнопки настроек на /app нет', async () => {
    portal.lag = true
    const w = await mountApp()
    expect(w.find('[data-testid="open-settings"]').exists()).toBe(false)
  })

  // Проверка отмечалась пройденной только после `setTitle`, а портал может с ответом не спешить:
  // всё это время страница рисовала меню разделов.
  it('портал молчит на setTitle — отказ всё равно показан сразу', async () => {
    portal.hangTitle = true
    const w = await mountSettings()
    expect(w.find('[data-testid="settings-admin-only"]').exists()).toBe(true)
    expect(w.find('[data-testid="settings-nav"]').exists()).toBe(false)
  })

  // Отказ — единственный заголовок экрана: h2 без h1 ломал бы дерево заголовков диктору.
  it('на странице отказа заголовок — h1', async () => {
    const w = await mountSettings()
    expect(w.find('[data-testid="settings-admin-only"] h1').exists()).toBe(true)
    expect(w.find('[data-testid="settings-admin-only"] h2').exists()).toBe(false)
  })
})
