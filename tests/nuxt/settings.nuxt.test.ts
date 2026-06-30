import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SettingsPage from '~/pages/settings.vue'
import { MOCK_CHATS } from '~/config/chat'
import { MOCK_STATEMENT } from '~/utils/mockStatement'

describe('settings page', () => {
  it('renders the form, chat options and a preview row per operation', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    const text = wrapper.text()
    expect(text).toContain('Настройки')
    // chat selector lists the mock chats
    for (const chat of MOCK_CHATS) expect(text).toContain(chat.title)
    // preview has one row per mock operation
    expect(wrapper.findAll('section li')).toHaveLength(MOCK_STATEMENT.items.length)
  })

  it('defaults to announcing credits and hiding debits in the preview', async () => {
    const wrapper = await mountSuspended(SettingsPage)
    const rows = wrapper.findAll('section li')
    // MOCK_STATEMENT order: credit, credit, debit → "→ в чат", "→ в чат", "скрыто"
    expect(rows[0]!.text()).toContain('в чат')
    expect(rows[2]!.text()).toContain('скрыто')
  })
})
