import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SettingsForm from '~/components/SettingsForm.vue'

// Admin gate: inside the portal, a non-admin sees a warning and NO form; an admin
// sees the form. Drive it through a mocked useB24 (real SDK can't load in tests).

const mockState = { isInit: true, isAdmin: true }

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return { useB24: () => makeMockB24({ isInit: () => mockState.isInit, isAdmin: mockState.isAdmin }) }
})

describe('SettingsForm admin gate', () => {
  it('in portal + NOT admin → warning, form hidden', async () => {
    mockState.isInit = true
    mockState.isAdmin = false
    const wrapper = await mountSuspended(SettingsForm)
    expect(wrapper.find('[data-testid="admin-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="notify-chat"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="error-chat"]').exists()).toBe(false)
  })

  it('in portal + admin → form shown, no warning', async () => {
    mockState.isInit = true
    mockState.isAdmin = true
    const wrapper = await mountSuspended(SettingsForm)
    expect(wrapper.find('[data-testid="admin-gate"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="notify-chat"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="error-chat"]').exists()).toBe(true)
  })

  it('outside the portal (standalone) → not blocked, form shown', async () => {
    mockState.isInit = false
    mockState.isAdmin = false
    const wrapper = await mountSuspended(SettingsForm)
    expect(wrapper.find('[data-testid="admin-gate"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="notify-chat"]').exists()).toBe(true)
  })
})
