import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import RecognitionMap from '~/components/RecognitionMap.vue'
import type { RecognitionSettings } from '~/utils/settings'

// Render/wiring test for the «карта сопоставления» editor. The recognition itself is covered
// in tests/purposeMatch.test.ts; here we check the form binds to the reactive model, adds/removes
// matrices, and the live preview runs the real recognizer.
function model(over: Partial<RecognitionSettings> = {}): RecognitionSettings {
  return reactive<RecognitionSettings>({ alphabet: 'cyrillic', matrices: [], configFields: {}, ...over })
}

describe('RecognitionMap', () => {
  it('renders the card, alphabet select, empty-state, add button and config-field rows', async () => {
    const wrapper = await mountSuspended(RecognitionMap, { props: { modelValue: model() } })
    expect(wrapper.find('[data-testid="recognition-map"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="recognition-alphabet"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="recognition-empty"]').exists()).toBe(true) // no matrices yet
    expect(wrapper.find('[data-testid="matrix-add"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="config-field-smart-entity"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="config-field-deal-field"]').exists()).toBe(true)
  })

  it('«Добавить матрицу» pushes a row into the model', async () => {
    const m = model()
    const wrapper = await mountSuspended(RecognitionMap, { props: { modelValue: m } })
    expect(wrapper.findAll('[data-testid="matrix-row"]')).toHaveLength(0)
    await wrapper.find('[data-testid="matrix-add"]').trigger('click')
    expect(m.matrices).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="matrix-row"]')).toHaveLength(1)
  })

  it('remove drops the matrix from the model', async () => {
    const m = model({ matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' }] })
    const wrapper = await mountSuspended(RecognitionMap, { props: { modelValue: m } })
    expect(wrapper.findAll('[data-testid="matrix-row"]')).toHaveLength(1)
    await wrapper.find('[data-testid="matrix-remove"]').trigger('click')
    expect(m.matrices).toHaveLength(0)
  })

  it('config field persists on input and CLEARS the key on blank (delete-on-blank)', async () => {
    const m = model()
    const wrapper = await mountSuspended(RecognitionMap, { props: { modelValue: m } })
    const input = wrapper.find('[data-testid="config-field-smart-entity"]')
    await input.setValue('1044')
    expect(m.configFields['smart-entity']).toBe('1044')
    // Blank ⇒ key removed entirely (resolver reads a missing key as "not configured").
    await input.setValue('   ')
    expect('smart-entity' in m.configFields).toBe(false)
  })

  it('a blank matrix note is stored as undefined, not an empty string', async () => {
    const m = model({ matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number', note: 'старый' }] })
    const wrapper = await mountSuspended(RecognitionMap, { props: { modelValue: m } })
    await wrapper.find('[aria-label="Комментарий"]').setValue('   ')
    expect(m.matrices[0]!.note).toBeUndefined()
  })

  it('live preview runs the real recognizer over the test purpose', async () => {
    const m = model({ matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' }] })
    const wrapper = await mountSuspended(RecognitionMap, { props: { modelValue: m } })
    await wrapper.find('[data-testid="recognition-preview-input"]').setValue('Оплата по счёту СЧ-1042')
    const out = wrapper.find('[data-testid="recognition-preview-out"]')
    expect(out.text()).toContain('СЧ-1042')
  })
})
