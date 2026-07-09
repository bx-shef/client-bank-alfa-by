import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { readFileSync } from 'node:fs'
import LandingDemo from '~/components/LandingDemo.vue'

// Render/wiring test for the file-upload demo. The extraction itself (normalize →
// summarize → recognize) is covered purely in tests/demoExtract.test.ts; here we
// assert the controls render and that uploading a real fixture fills the results.
// (The online Alfa/Prior sandbox buttons were retired in favour of info cards in
// index.vue — they no longer exist in this component.)

/** A browser File backed by a real windows-1251 fixture's bytes. Resolved from the
 *  repo-root cwd (import.meta.url is unset in the nuxt test environment). */
function fixtureFile(rel: string, name: string): File {
  const bytes = readFileSync(`tests/fixtures/${rel}`)
  return new File([bytes], name, { type: 'text/plain' })
}

/** Drain a few macrotasks so the async batch processor (which defers between files)
 *  settles before we assert on the rendered result. */
async function flush(ticks = 5) {
  for (let i = 0; i < ticks; i++) await new Promise(r => setTimeout(r))
}

async function upload(wrapper: Awaited<ReturnType<typeof mountSuspended>>, file: File) {
  const input = wrapper.find('[data-testid="demo-file-input"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flush()
  await wrapper.vm.$nextTick()
}

describe('LandingDemo', () => {
  it('renders the dropzone/privacy, and NO Alfa/Prior sandbox buttons', async () => {
    const wrapper = await mountSuspended(LandingDemo)
    expect(wrapper.find('[data-testid="demo-dropzone"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="demo-file-input"]').exists()).toBe(true)
    // Privacy warning is always visible (think about what you upload to a public demo).
    expect(wrapper.find('[data-testid="demo-privacy"]').exists()).toBe(true)
    // The interactive sandbox buttons were removed.
    expect(wrapper.find('[data-testid="demo-alfa"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="demo-prior"]').exists()).toBe(false)
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

  it('uploading a real statement file fills the summary and operations', async () => {
    const wrapper = await mountSuspended(LandingDemo)
    await upload(wrapper, fixtureFile('client-bank/demo-type4-alfa.txt', 'demo.txt'))
    expect(wrapper.find('[data-testid="demo-summary"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="demo-operation"]').length).toBeGreaterThan(0)
  })

  it('the reset button clears the results', async () => {
    const wrapper = await mountSuspended(LandingDemo)
    await upload(wrapper, fixtureFile('client-bank/demo-type4-alfa.txt', 'demo.txt'))
    expect(wrapper.find('[data-testid="demo-summary"]').exists()).toBe(true)
    await wrapper.find('[data-testid="demo-reset"]').trigger('click')
    expect(wrapper.find('[data-testid="demo-summary"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="demo-reset"]').exists()).toBe(false)
  })

  it('shows an error when a file cannot be parsed', async () => {
    const wrapper = await mountSuspended(LandingDemo)
    // A wrong-extension file fails validation → the all-failed error branch.
    await upload(wrapper, new File(['not a statement'], 'scan.pdf', { type: 'application/pdf' }))
    expect(wrapper.find('[data-testid="demo-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="demo-summary"]').exists()).toBe(false)
  })
})
