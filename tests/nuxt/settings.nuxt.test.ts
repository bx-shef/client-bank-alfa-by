import { beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import SettingsPage from '~/pages/settings.vue'
import { MOCK_CHATS } from '~/config/chat'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { defaultSettings, useChatRules } from '~/composables/useChatRules'

// useChatRules() is a module-level singleton — reset it (and storage) between
// tests so order can't leak state.
beforeEach(() => {
  useChatRules().settings.value = defaultSettings()
  if (typeof localStorage !== 'undefined') localStorage.clear()
})

const creditIdx = MOCK_STATEMENT.items.findIndex(i => i.direction === 'credit')
const debitIdx = MOCK_STATEMENT.items.findIndex(i => i.direction === 'debit')

function previewRows(wrapper: VueWrapper) {
  return wrapper.findAll('[data-testid="preview-list"] li')
}

describe('settings page', () => {
  it('renders the heading, chat options and one preview row per operation', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    expect(wrapper.text()).toContain('Настройки')
    for (const chat of MOCK_CHATS) expect(wrapper.text()).toContain(chat.title)
    expect(previewRows(wrapper)).toHaveLength(MOCK_STATEMENT.items.length)
  })

  it('by default announces credits and hides debits', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    const rows = previewRows(wrapper)
    expect(rows[creditIdx]!.text()).toContain('в чат')
    expect(rows[debitIdx]!.text()).toContain('скрыто')
  })

  it('unchecking "Приходы" hides the credit in the preview', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    // first checkbox is "Приходы" (credit)
    await wrapper.findAll('input[type="checkbox"]')[0]!.trigger('change')
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('скрыто')
  })

  it('excluding the account hides matching credits in the preview', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    await wrapper.find('textarea[placeholder="BY00..."]').setValue(MOCK_STATEMENT.items[creditIdx]!.account)
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('скрыто')
  })
})

describe('defaultSettings', () => {
  it('announces only credits and starts empty', () => {
    expect(defaultSettings()).toEqual({
      apiKey: '', chatId: '', directions: ['credit'], excludeAccounts: [], excludePurposePatterns: []
    })
  })
})
