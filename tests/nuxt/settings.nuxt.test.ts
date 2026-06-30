import { beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import SettingsPage from '~/pages/settings.vue'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { defaultSettings, useChatRules } from '~/composables/useChatRules'

// useChatRules() is a module-level singleton — reset it (and storage) between
// tests so order can't leak state. The preview reacts to this same singleton, so
// we drive the filter through it rather than through b24ui component internals.
beforeEach(() => {
  useChatRules().settings.value = defaultSettings()
  if (typeof localStorage !== 'undefined') localStorage.clear()
})

const creditIdx = MOCK_STATEMENT.items.findIndex(i => i.direction === 'credit')
const debitIdx = MOCK_STATEMENT.items.findIndex(i => i.direction === 'debit')
const creditCount = MOCK_STATEMENT.items.filter(i => i.direction === 'credit').length

function previewRows(wrapper: VueWrapper) {
  return wrapper.findAll('[data-testid="preview-list"] li')
}

describe('settings page', () => {
  it('renders the heading, the grouped sections and one preview row per operation', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    const text = wrapper.text()
    expect(text).toContain('Настройки')
    expect(text).toContain('Подключение банка')
    expect(text).toContain('Уведомления в чат')
    expect(text).toContain('Исключения')
    expect(previewRows(wrapper)).toHaveLength(MOCK_STATEMENT.items.length)
  })

  it('by default announces credits and hides debits', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    const rows = previewRows(wrapper)
    expect(rows[creditIdx]!.text()).toContain('в чат')
    expect(rows[debitIdx]!.text()).toContain('скрыто')
  })

  it('summary counts how many operations reach the chat', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    expect(wrapper.find('[data-testid="preview-summary"]').text())
      .toContain(`В чат попадёт ${creditCount} из ${MOCK_STATEMENT.items.length}`)
  })

  it('disabling "Приходы" hides the credit in the preview', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    useChatRules().settings.value.directions = ['debit']
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('скрыто')
  })

  it('excluding a purpose pattern hides the matching credit (selective)', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    // Exclude only the first credit's purpose — the other credit stays announced,
    // so the list still renders (not the "everything hidden" warning).
    useChatRules().settings.value.excludePurposePatterns = [MOCK_STATEMENT.items[creditIdx]!.purpose]
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('скрыто')
  })

  it('warns (and drops the list) when the rules hide everything', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    useChatRules().settings.value.directions = []
    await nextTick()
    expect(wrapper.find('[data-testid="preview-list"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('в чат ничего не попадёт')
  })
})

describe('defaultSettings', () => {
  it('announces only credits and starts empty', () => {
    expect(defaultSettings()).toEqual({
      apiKey: '', chatId: '', directions: ['credit'], excludeAccounts: [], excludePurposePatterns: []
    })
  })
})
