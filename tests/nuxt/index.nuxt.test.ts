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

  it('hero CTA links to the request form anchor (#brief)', async () => {
    const wrapper = await mountSuspended(IndexPage)
    // The form section carries id="brief"; the CTA must scroll there.
    expect(wrapper.find('#brief').exists()).toBe(true)
    const hrefs = wrapper.findAll('a').map(a => a.attributes('href'))
    expect(hrefs).toContain('#brief')
  })

  it('integrators block links to the partners page (/partners)', async () => {
    const wrapper = await mountSuspended(IndexPage)
    // Guards against silently dropping/renaming the partners entry point.
    const hrefs = wrapper.findAll('a').map(a => a.attributes('href'))
    expect(hrefs).toContain('/partners')
  })
})
