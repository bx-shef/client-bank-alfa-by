import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import AppPage from '~/pages/app.vue'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { splitByDirection } from '~/utils/statement'

const { credits, debits } = splitByDirection(MOCK_STATEMENT.items)

describe('app statement page', () => {
  it('renders the account, demo notice and the filter chips with counts', async () => {
    const wrapper = await mountSuspended(AppPage)
    const text = wrapper.text()
    expect(text).toContain(MOCK_STATEMENT.account)
    expect(text).toContain('Демо-данные')
    expect(text).toContain('Последние операции')
    // Chip filter (replaced the old tabs): Все / Приходы / Расходы with counts.
    expect(text).toContain(`Все (${MOCK_STATEMENT.items.length})`)
    expect(text).toContain(`Приходы (${credits.length})`)
    expect(text).toContain(`Расходы (${debits.length})`)
  })

  it('defaults to "Все" — every operation is listed, with the currency', async () => {
    const wrapper = await mountSuspended(AppPage)
    const text = wrapper.text()
    for (const item of MOCK_STATEMENT.items) expect(text).toContain(item.counterparty.name)
    expect(text).toContain(MOCK_STATEMENT.items[0]!.currency)
  })

  it('clicking the "Расходы" chip filters the list to debits only', async () => {
    const wrapper = await mountSuspended(AppPage)
    const chip = wrapper.findAll('button').find(b => b.text().includes('Расходы ('))
    expect(chip).toBeTruthy()
    await chip!.trigger('click')
    await nextTick()
    const text = wrapper.text()
    for (const d of debits) expect(text).toContain(d.counterparty.name)
    // Credit counterparties are filtered out of the list.
    for (const c of credits) expect(text).not.toContain(c.counterparty.name)
  })
})
