import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AppPage from '~/pages/app.vue'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { splitByDirection } from '~/utils/statement'

const { credits, debits } = splitByDirection(MOCK_STATEMENT.items)

describe('app statement page', () => {
  it('renders the account, demo notice and tabs with counts', async () => {
    const wrapper = await mountSuspended(AppPage)
    const text = wrapper.text()
    expect(text).toContain(MOCK_STATEMENT.account)
    expect(text).toContain('Демо-данные')
    expect(text).toContain(`Приходы (${credits.length})`)
    expect(text).toContain(`Расходы (${debits.length})`)
  })

  it('shows the active (Приходы) tab operations with the currency in the total', async () => {
    const wrapper = await mountSuspended(AppPage)
    const text = wrapper.text()
    // Credits are the default active tab — their counterparties must be visible.
    for (const c of credits) expect(text).toContain(c.counterparty.name)
    expect(text).toContain(MOCK_STATEMENT.items[0]!.currency)
  })
})
