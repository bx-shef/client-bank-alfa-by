import { beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import SettingsPage from '~/pages/settings.vue'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { useChatSettings } from '~/composables/useChatSettings'
import { defaultPortalSettings } from '~/utils/settings'

// useChatSettings() is a module-level singleton — reset it between tests so order
// can't leak state. The preview reacts to the same singleton, so we drive the
// filter through it rather than through b24ui component internals. Outside the
// frame (test env: no window.name) the form is not admin-blocked and renders in
// preview mode (persistence is inert).
beforeEach(() => {
  Object.assign(useChatSettings().settings, defaultPortalSettings())
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
    expect(text).toContain('Уведомления в чат')
    expect(text).toContain('Чат для ошибок')
    expect(text).toContain('Исключения')
    expect(previewRows(wrapper)).toHaveLength(MOCK_STATEMENT.items.length)
  })

  it('renders the custom-development cross-sell card', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    expect(wrapper.text()).toContain('Нужна доработка под ваш процесс?')
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
    useChatSettings().settings.chat.rules.directions = ['debit']
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('скрыто')
  })

  it('excluding a purpose pattern hides the matching credit (selective)', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    useChatSettings().settings.chat.rules.excludePurposePatterns = [MOCK_STATEMENT.items[creditIdx]!.purpose]
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('скрыто')
  })

  it('warns (and drops the list) when the rules hide everything', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    useChatSettings().settings.chat.rules.directions = []
    await nextTick()
    expect(wrapper.find('[data-testid="preview-list"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('в чат ничего не попадёт')
  })

  // Drive the real UI controls (not just the singleton) so the component wiring
  // — directionModel get/set on B24Switch, the textarea→settings watch — is covered.
  it('toggling the "Приходы" switch off hides the credit (UI wiring)', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    const sw = wrapper.find('[data-testid="notify-credit"]')
    expect(sw.exists()).toBe(true)
    await sw.trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="preview-list"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('в чат ничего не попадёт')
  })

  it('typing an exclude pattern hides the matching credit (UI wiring)', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    const textarea = wrapper.find('textarea[data-testid="exclude-patterns"]')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue(MOCK_STATEMENT.items[creditIdx]!.purpose)
    await nextTick()
    expect(previewRows(wrapper)[creditIdx]!.text()).toContain('скрыто')
  })
})
