import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import IndexPage from '~/pages/index.vue'

describe('index landing page', () => {
  it('renders the app title and all features', async () => {
    const wrapper = await mountSuspended(IndexPage)
    const text = wrapper.text()

    expect(text).toContain('Клиент-банк Альфа-Банк Беларусь')
    expect(text).toContain('Выписка из клиент-банка')
    expect(text).toContain('Интеграция с Bitrix24')
  })
})
