import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import LandingDemo from '~/components/LandingDemo.vue'

// Render/wiring test. The extraction itself (normalize → summarize → recognize) is
// covered purely in tests/demoExtract.test.ts; here we assert the controls render
// and that clicking a bank sandbox button fills the results region. The file
// drag-drop path is verified visually (screenshots with a fixture file).
describe('LandingDemo', () => {
  it('renders the source controls and dropzone, no results before use', async () => {
    const wrapper = await mountSuspended(LandingDemo)
    expect(wrapper.find('[data-testid="demo-alfa"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="demo-prior"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="demo-dropzone"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="demo-file-input"]').exists()).toBe(true)
    // Nothing extracted yet.
    expect(wrapper.find('[data-testid="demo-summary"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="demo-operation"]').exists()).toBe(false)
  })

  it('the file input accepts only .txt and allows multiple', async () => {
    const wrapper = await mountSuspended(LandingDemo)
    const input = wrapper.find('[data-testid="demo-file-input"]')
    expect(input.attributes('accept')).toContain('.txt')
    expect(input.attributes('multiple')).toBeDefined()
  })

  it('running the Alfa sandbox demo fills the summary and operations', async () => {
    const wrapper = await mountSuspended(LandingDemo)
    await wrapper.find('[data-testid="demo-alfa"]').trigger('click')
    expect(wrapper.find('[data-testid="demo-summary"]').exists()).toBe(true)
    // The Alfa sample has 3 operations.
    expect(wrapper.findAll('[data-testid="demo-operation"]')).toHaveLength(3)
    // It recognizes identifiers and renders the value + human label (not just the block).
    const recognized = wrapper.find('[data-testid="demo-recognized"]')
    expect(recognized.exists()).toBe(true)
    expect(recognized.text()).toContain('СЧ-1042')
    expect(recognized.text()).toContain('Смарт-счёт')
  })

  it('the reset button clears the results', async () => {
    const wrapper = await mountSuspended(LandingDemo)
    await wrapper.find('[data-testid="demo-alfa"]').trigger('click')
    expect(wrapper.find('[data-testid="demo-summary"]').exists()).toBe(true)
    await wrapper.find('[data-testid="demo-reset"]').trigger('click')
    expect(wrapper.find('[data-testid="demo-summary"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="demo-reset"]').exists()).toBe(false)
  })

  it('shows an error when a file cannot be parsed', async () => {
    const wrapper = await mountSuspended(LandingDemo)
    // A wrong-extension file fails validation → the all-failed error branch.
    const bad = new File(['not a statement'], 'scan.pdf', { type: 'application/pdf' })
    const input = wrapper.find('[data-testid="demo-file-input"]')
    Object.defineProperty(input.element, 'files', { value: [bad], configurable: true })
    await input.trigger('change')
    // Let the async batch processor settle.
    await new Promise(r => setTimeout(r))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="demo-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="demo-summary"]').exists()).toBe(false)
  })

  it('running the Prior sandbox demo fills the summary and operations', async () => {
    const wrapper = await mountSuspended(LandingDemo)
    await wrapper.find('[data-testid="demo-prior"]').trigger('click')
    expect(wrapper.find('[data-testid="demo-summary"]').exists()).toBe(true)
    // The Prior sample has 2 operations.
    expect(wrapper.findAll('[data-testid="demo-operation"]')).toHaveLength(2)
  })
})
