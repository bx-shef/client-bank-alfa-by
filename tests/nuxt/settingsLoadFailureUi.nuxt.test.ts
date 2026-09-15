import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import SettingsForm from '~/components/SettingsForm.vue'
import { defaultPortalSettings } from '~/utils/settings'

// Подача состояния «настройки прочитать не удалось» (#705): форма обязана СКАЗАТЬ об этом и
// запретить сохранение. Несущий запрет живёт в самом `cs.save()` (его гард — в
// `settingsLoadFailure.nuxt.test.ts`); здесь проверяется, что человек видит причину и что
// кнопка не приглашает затереть настройки портала дефолтами.

const save = vi.fn(async () => {})
const load = vi.fn(async () => {})
const cs = {
  settings: reactive(defaultPortalSettings()),
  enabled: ref(true),
  loading: ref(false),
  saving: ref(false),
  savedOk: ref(false),
  loaded: ref(true),
  loadFailed: ref(true),
  error: ref('Не удалось загрузить настройки'),
  notifyOption: ref(undefined),
  errorOption: ref(undefined),
  chatFetcher: async () => ({ items: [], hasMore: false }),
  load,
  save
}

vi.mock('~/composables/useChatSettings', () => ({ useChatSettings: () => cs }))
vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return { useB24: () => makeMockB24({ isInit: () => true, isAdmin: true }) }
})

async function mountForm() {
  const wrapper = await mountSuspended(SettingsForm, { props: { section: 'chats' } })
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('SettingsForm: настройки не прочитаны (#705)', () => {
  it('показывает отказ чтения', async () => {
    const wrapper = await mountForm()
    expect(wrapper.find('[data-testid="settings-load-failed"]').exists()).toBe(true)
  })

  it('ГАРД: «Сохранить» заблокирована и клик не зовёт save()', async () => {
    // Мутация «убрать `loadFailed` из :disabled» или «убрать ранний выход из saveAndClose»
    // обязана ронять этот тест — иначе обычное действие админа затирает настройки портала.
    save.mockClear()
    const wrapper = await mountForm()
    const btn = wrapper.find('[data-testid="settings-save"]')
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    await flushPromises()
    expect(save).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('прочитанные настройки отказ не показывают и сохранение не блокируют', async () => {
    cs.loadFailed.value = false
    cs.error.value = ''
    save.mockClear()
    const wrapper = await mountForm()
    expect(wrapper.find('[data-testid="settings-load-failed"]').exists()).toBe(false)
    await wrapper.find('[data-testid="settings-save"]').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledOnce()
    cs.loadFailed.value = true
    cs.error.value = 'Не удалось загрузить настройки'
  })
})
