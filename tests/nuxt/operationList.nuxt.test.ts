import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import OperationList from '~/components/OperationList.vue'
import type { StatementItem } from '~/types/statement'

// Канал отзывов серверный; здесь он включён мокой, иначе виджет в раскрытой строке не рисуется
// вовсе и проверять было бы нечего.
const feedback = { submit: vi.fn(async () => true), rated: new Set<string>() }
vi.mock('~/composables/useFeedback', () => ({
  useFeedback: () => ({
    enabled: ref(true),
    ensureEnabled: vi.fn(async () => {}),
    submit: feedback.submit,
    alreadyRated: (k?: string) => !!k && feedback.rated.has(k),
    rememberRated: (k?: string) => {
      if (k) feedback.rated.add(k)
    }
  })
}))

afterEach(() => {
  feedback.submit = vi.fn(async () => true)
  feedback.rated.clear()
})

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

describe('OperationList — отзыв о КОНКРЕТНОМ платеже (#499)', () => {
  it('виджет появляется в раскрытой строке и несёт поля именно этого платежа', async () => {
    const item = op({
      docId: 'c9', direction: 'credit', amount: 777.5, currency: 'BYN',
      purpose: 'Оплата по счёту СЧ-42',
      counterparty: { name: 'ООО Ромашка', unp: '191234567', account: 'BY00BANK0001' }
    })
    const wrapper = await mountSuspended(OperationList, { props: { items: [item] } })
    // Строка свёрнута: виджета ещё нет — сто виджетов в списке это сто раз «не нажимайте меня».
    expect(wrapper.find('[data-testid="feedback-widget"]').exists()).toBe(false)

    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="feedback-widget"]').exists()).toBe(true)

    await wrapper.find('[data-testid="feedback-up"]').trigger('click')
    await flushPromises()
    const [, , context] = feedback.submit.mock.calls[0] as unknown as [string, string | undefined, Record<string, unknown>]
    expect(context.place).toBe('операция')
    expect(context.operation).toMatchObject({
      direction: 'credit',
      amount: 777.5,
      currency: 'BYN',
      purpose: 'Оплата по счёту СЧ-42',
      counterparty: 'ООО Ромашка',
      counterpartyAccount: 'BY00BANK0001',
      counterpartyUnp: '191234567'
    })
    // `kind` — про то, на чём запуталась ПРОГРАММА; в отзыве человека его быть не должно.
    expect(context.operation).not.toHaveProperty('kind')
  })
})
