import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import SettingsForm from '~/components/SettingsForm.vue'
import { defaultPortalSettings } from '~/utils/settings'

// Explicit Save/Cancel (starter #219 UX). The footer renders only in-portal (enabled), so
// we drive a mocked useChatSettings (enabled + spyable save/load) and a mocked useB24 (admin
// gate open). Covers: Save persists then closes the slideover; Cancel discards (load) then
// closes; page-mode Cancel discards WITHOUT emitting close.

const save = vi.fn(async () => {})
const load = vi.fn(async () => {})
const cs = {
  settings: reactive(defaultPortalSettings()),
  enabled: ref(true),
  loading: ref(false),
  saving: ref(false),
  savedOk: ref(false),
  loaded: ref(true),
  error: ref(''),
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

async function mountForm(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(SettingsForm, { props })
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('SettingsForm Save/Cancel', () => {
  it('renders the Save/Cancel footer in-portal (admin)', async () => {
    const wrapper = await mountForm()
    expect(wrapper.find('[data-testid="settings-save"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-cancel"]').exists()).toBe(true)
  })

  it('Save persists then closes the slideover (asSlider)', async () => {
    save.mockClear()
    const wrapper = await mountForm({ asSlider: true })
    await wrapper.find('[data-testid="settings-save"]').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledOnce()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('Save keeps the panel open when the save errors', async () => {
    save.mockClear()
    cs.error.value = 'boom' // save() would set this; simulate a failed save
    const wrapper = await mountForm({ asSlider: true })
    await wrapper.find('[data-testid="settings-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    cs.error.value = ''
  })

  it('Cancel discards (reloads server copy) then closes the slideover (asSlider)', async () => {
    load.mockClear()
    const wrapper = await mountForm({ asSlider: true })
    await wrapper.find('[data-testid="settings-cancel"]').trigger('click')
    await flushPromises()
    expect(load).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('page-mode Cancel discards WITHOUT emitting close', async () => {
    load.mockClear()
    const wrapper = await mountForm() // no asSlider → plain page
    await wrapper.find('[data-testid="settings-cancel"]').trigger('click')
    await flushPromises()
    expect(load).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})
