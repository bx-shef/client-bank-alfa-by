import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import OperationList from '~/components/OperationList.vue'
import type { StatementItem } from '~/types/statement'

function op(over: Partial<StatementItem>): StatementItem {
  return {
    account: 'BY00', docId: 'd1', direction: 'credit', amount: 100, currency: 'BYN',
    purpose: 'Тест', counterparty: { name: 'ООО «Тест»', unp: '1', account: 'BY11' },
    acceptDate: '2026-06-27T10:00:00.000Z', ...over
  }
}

describe('OperationList', () => {
  it('shows a calm empty state when there are no operations', async () => {
    const wrapper = await mountSuspended(OperationList, { props: { items: [] } })
    expect(wrapper.text()).toContain('Пока пусто')
  })

  it('renders a row per operation with counterparty and a signed, coloured amount', async () => {
    const items = [
      op({ docId: 'c1', direction: 'credit', amount: 320.5, counterparty: { name: 'ИП Петров', unp: '2', account: 'BY22' } }),
      op({ docId: 'd1', direction: 'debit', amount: 540, counterparty: { name: 'ООО Бизнес', unp: '3', account: 'BY33' } })
    ]
    const wrapper = await mountSuspended(OperationList, { props: { items } })
    const text = wrapper.text()
    expect(text).toContain('ИП Петров')
    expect(text).toContain('ООО Бизнес')
    // credit is signed +, debit signed − (U+2212), both with the currency
    expect(text).toContain('+320,50 BYN')
    expect(text).toContain('−540,00 BYN')
  })

  it('groups operations by day (a header per distinct date)', async () => {
    const items = [
      op({ docId: 'a', acceptDate: '2026-06-27T09:00:00.000Z' }),
      op({ docId: 'b', acceptDate: '2026-06-26T09:00:00.000Z' })
    ]
    const wrapper = await mountSuspended(OperationList, { props: { items } })
    const text = wrapper.text()
    expect(text).toContain('27 июня')
    expect(text).toContain('26 июня')
  })
})
