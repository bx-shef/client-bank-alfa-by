import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AppPage from '~/pages/app.vue'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { splitByDirection } from '~/utils/statement'

const { credits, debits } = splitByDirection(MOCK_STATEMENT.items)

describe('app statement page', () => {
  it('renders the heading, account and demo notice', async () => {
    const wrapper = await mountSuspended(AppPage)
    const text = wrapper.text()
    expect(text).toContain('Выписка по счёту')
    expect(text).toContain(MOCK_STATEMENT.account)
    expect(text).toContain('Демо-данные')
  })

  it('renders one card per operation, split into Приходы / Расходы', async () => {
    const wrapper = await mountSuspended(AppPage)
    const text = wrapper.text()
    expect(wrapper.findAll('li')).toHaveLength(MOCK_STATEMENT.items.length)
    expect(text).toContain(`Приходы`)
    expect(text).toContain(`Расходы`)
    // Section counts reflect the split.
    expect(text).toContain(`(${credits.length})`)
    expect(text).toContain(`(${debits.length})`)
  })

  it('shows the currency in totals (not hard-coded)', async () => {
    const wrapper = await mountSuspended(AppPage)
    expect(wrapper.text()).toContain(MOCK_STATEMENT.items[0]!.currency)
  })
})
