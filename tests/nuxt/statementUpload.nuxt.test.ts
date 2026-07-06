import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import StatementUpload from '~/components/StatementUpload.vue'

// Render/wiring test. The parse itself (windows-1251 decode → operations, dedup,
// validation) is covered on real fixtures in tests/importUpload.test.ts; the
// drag-drop parse flow is verified visually (screenshots with a fixture file).
describe('StatementUpload', () => {
  it('renders the dropzone and pick button, no preview before any file', async () => {
    const wrapper = await mountSuspended(StatementUpload)
    expect(wrapper.find('[data-testid="dropzone"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pick"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-input"]').exists()).toBe(true)
    // No results yet → no file list, no summary, no clear button.
    expect(wrapper.find('[data-testid="file-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="summary"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="clear"]').exists()).toBe(false)
  })

  it('the file input accepts only .txt and allows multiple', async () => {
    const wrapper = await mountSuspended(StatementUpload)
    const input = wrapper.find('[data-testid="file-input"]')
    expect(input.attributes('accept')).toContain('.txt')
    expect(input.attributes('multiple')).toBeDefined()
  })
})
