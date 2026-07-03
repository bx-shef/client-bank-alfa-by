import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import IndexPage from '~/pages/index.vue'
import { LANDING_FEATURES, LANDING_TITLE } from '~/utils/landing'

describe('index landing page', () => {
  it('renders the app title and description', async () => {
    const wrapper = await mountSuspended(IndexPage)
    expect(wrapper.text()).toContain(LANDING_TITLE)
  })

  it('renders one card per feature (guards against an empty v-for)', async () => {
    const wrapper = await mountSuspended(IndexPage)
    const cards = wrapper.findAll('[data-testid="feature-card"]')
    expect(cards).toHaveLength(LANDING_FEATURES.length)
    // Every feature's title must actually appear in its card.
    for (const feature of LANDING_FEATURES) {
      expect(wrapper.text()).toContain(feature.title)
    }
  })

  it('renders a footer author link with a non-empty href', async () => {
    const wrapper = await mountSuspended(IndexPage)
    const link = wrapper.find('footer a')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBeTruthy()
    expect(link.text().trim()).not.toBe('')
  })
})
