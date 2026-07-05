import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AsyncSearchSelect from '~/components/AsyncSearchSelect.vue'

// Render/wiring test. The menu content (states / load-more) only renders while the
// combobox is open, which happy-dom won't drive, so here we cover what IS
// assertable: lazy mount (no fetch until first open) and selected-label
// persistence via selectedOption. The interactive states are covered by the
// composable tests + manual/visual verification in the consumer page.

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('AsyncSearchSelect', () => {
  it('does NOT fetch on mount — the default list loads lazily on first open', async () => {
    const fetcher = vi.fn(async () => ({ items: [{ value: 'c1', label: 'Отдел продаж' }], total: 1 }))
    const wrapper = await mountSuspended(AsyncSearchSelect, {
      props: { fetcher, placeholder: 'Выберите чат' }
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(fetcher).not.toHaveBeenCalled() // idle pickers don't hit the backend
    expect(wrapper.text()).toContain('Выберите чат') // placeholder while unselected
  })

  it('shows the selected option label without a fetch (persists across reload)', async () => {
    const fetcher = vi.fn(async () => ({ items: [], total: 0 }))
    const wrapper = await mountSuspended(AsyncSearchSelect, {
      props: {
        fetcher,
        modelValue: 'chat42',
        selectedOption: { value: 'chat42', label: 'АО Ромашка' }
      }
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(wrapper.text()).toContain('АО Ромашка')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
