import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AsyncSearchSelect from '~/components/AsyncSearchSelect.vue'

// Render/wiring test: the component mounts over b24ui SelectMenu and drives the
// injected fetcher through useRemoteSearch. The menu content (states / sentinel)
// only renders while the combobox is open, so here we prove mount + wiring (the
// fetcher is invoked with the empty default query); the state UI is covered by
// the composable tests + manual/visual verification in the consumer page.

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('AsyncSearchSelect', () => {
  it('mounts and fetches the default list via the injected fetcher', async () => {
    const fetcher = vi.fn(async () => ({
      items: [{ value: 'chat1', label: 'Отдел продаж' }],
      total: 1
    }))
    const wrapper = await mountSuspended(AsyncSearchSelect, {
      props: { fetcher, placeholder: 'Выберите чат' }
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(fetcher).toHaveBeenCalledWith('', 0, expect.anything())
    // The trigger renders the placeholder while nothing is selected.
    expect(wrapper.text()).toContain('Выберите чат')
  })

  it('respects a custom minChars (no fetch until reached is composable-tested; mount still works)', async () => {
    const fetcher = vi.fn(async () => ({ items: [], total: 0 }))
    const wrapper = await mountSuspended(AsyncSearchSelect, {
      props: { fetcher, minChars: 2, valueKey: 'id', labelKey: 'title' }
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(wrapper.exists()).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1) // empty default query on mount
  })
})
