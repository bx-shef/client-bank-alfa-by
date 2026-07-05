import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import IndexPage from '~/pages/index.vue'
import AppInBitrixCard from '~/components/AppInBitrixCard.vue'
import { LANDING_FEATURES, LANDING_TITLE, LANDING_MARKET_PROMO, LANDING_MARKET_URL } from '~/utils/landing'

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

  it('renders the Marketplace promo card wired for the funnel', async () => {
    const wrapper = await mountSuspended(IndexPage)
    // The agreed copy is on the page and the CTA links to the free-app listing.
    expect(wrapper.text()).toContain(LANDING_MARKET_PROMO.title)
    const hrefs = wrapper.findAll('a').map(a => a.attributes('href'))
    expect(hrefs).toContain(LANDING_MARKET_URL)
    // Wiring the fix-commit relies on: the card fires its OWN goal (not the hero's
    // `market_click`) and stays visually subordinate to the paid primary CTA.
    const card = wrapper.findComponent(AppInBitrixCard)
    expect(card.exists()).toBe(true)
    expect(card.props('clickGoal')).toBe('market_card_click')
    expect(card.props('ctaColor')).toBe('air-secondary-no-accent')
    expect(card.props('url')).toBe(LANDING_MARKET_URL)
  })
})
