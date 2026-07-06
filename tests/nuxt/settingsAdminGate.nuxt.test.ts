import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsForm from '~/components/SettingsForm.vue'

// Admin gate: inside the portal, a non-admin sees a warning and NO form; an admin
// sees the form. Drive it through a mocked useB24 (real SDK can't load in tests).
// The gate is default-CLOSED — content is withheld until the onMounted admin-check
// (await init + nextTick + checkAdmin) resolves, so we flush before asserting.

const mockState = { isInit: true, isAdmin: true }

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return { useB24: () => makeMockB24({ isInit: () => mockState.isInit, isAdmin: mockState.isAdmin }) }
})

async function mountReady() {
  const wrapper = await mountSuspended(SettingsForm)
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('SettingsForm admin gate', () => {
  // NB the gate is default-CLOSED by construction: `adminChecked` starts false and
  // the form sits behind `v-else` after the warning, so content can't render before
  // the check. The non-admin case below proves the form never shows without admin.

  it('in portal + NOT admin → warning, form hidden', async () => {
    mockState.isInit = true
    mockState.isAdmin = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="admin-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="notify-chat"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="error-chat"]').exists()).toBe(false)
  })

  it('in portal + admin → form shown, no warning', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="admin-gate"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="notify-chat"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="error-chat"]').exists()).toBe(true)
  })

  it('outside the portal (standalone) → not blocked, form shown', async () => {
    mockState.isInit = false
    mockState.isAdmin = false
    const wrapper = await mountReady()
    expect(wrapper.find('[data-testid="admin-gate"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="notify-chat"]').exists()).toBe(true)
  })
})
