import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { useRemoteSearch, type UseRemoteSearch } from '~/composables/useRemoteSearch'
import type { RemoteSearchPage } from '~/utils/remoteSearch'

// Drive the composable through a tiny harness (captures the reactive API into a
// module ref) so we can poke searchTerm and assert items/loading/race handling
// with fake timers for the debounce.

type Row = { value: string, label: string }
const row = (id: string): Row => ({ value: id, label: `chat ${id}` })

let api: UseRemoteSearch<Row>

async function mountHarness(fetcher: (q: string, offset: number) => Promise<RemoteSearchPage<Row>>) {
  const Harness = defineComponent({
    setup() {
      api = useRemoteSearch<Row>({ fetcher, keyOf: r => r.value, minChars: 3, debounceMs: 250 })
      return () => h('div')
    }
  })
  return mountSuspended(Harness)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useRemoteSearch', () => {
  it('fetches the default (empty-query) list immediately on mount', async () => {
    const fetcher = vi.fn(async () => ({ items: [row('1'), row('2')], total: 2 }))
    await mountHarness(fetcher)
    await vi.advanceTimersByTimeAsync(300)
    expect(fetcher).toHaveBeenCalledWith('', 0, expect.anything())
    expect(api.items.value.map(r => r.value)).toEqual(['1', '2'])
    expect(api.loading.value).toBe(false)
  })

  it('too-short term does not hit the network and clears results', async () => {
    const fetcher = vi.fn(async () => ({ items: [row('1')], total: 1 }))
    await mountHarness(fetcher)
    await vi.advanceTimersByTimeAsync(300)
    fetcher.mockClear()

    api.searchTerm.value = 'ab' // below minChars=3
    await vi.advanceTimersByTimeAsync(300)
    expect(fetcher).not.toHaveBeenCalled()
    expect(api.tooShort.value).toBe(true)
    expect(api.items.value).toEqual([])
  })

  it('valid term searches from offset 0', async () => {
    const fetcher = vi.fn(async (q: string) => ({ items: [row(`${q}-1`)], total: 5 }))
    await mountHarness(fetcher)
    await vi.advanceTimersByTimeAsync(300)

    api.searchTerm.value = 'ромаш'
    await vi.advanceTimersByTimeAsync(300)
    expect(fetcher).toHaveBeenLastCalledWith('ромаш', 0, expect.anything())
    expect(api.items.value.map(r => r.value)).toEqual(['ромаш-1'])
    expect(api.hasMore.value).toBe(true) // 1 loaded of 5
  })

  it('loadMore appends the next page (offset = loaded), de-duped', async () => {
    const pages: Record<number, Row[]> = { 0: [row('1'), row('2')], 2: [row('2'), row('3')] }
    const fetcher = vi.fn(async (_q: string, offset: number) => ({ items: pages[offset] ?? [], total: 3 }))
    await mountHarness(fetcher)
    await vi.advanceTimersByTimeAsync(300) // empty-query default = page 0

    await api.loadMore()
    await vi.advanceTimersByTimeAsync(10)
    expect(fetcher).toHaveBeenLastCalledWith('', 2, expect.anything())
    expect(api.items.value.map(r => r.value)).toEqual(['1', '2', '3']) // '2' not duplicated
    expect(api.hasMore.value).toBe(false)
  })

  it('drops a stale response when a newer query supersedes it', async () => {
    // First query resolves slowly; second resolves fast. Only the second wins.
    const deferred: Array<() => void> = []
    const fetcher = vi.fn((q: string) =>
      new Promise<RemoteSearchPage<Row>>((resolve) => {
        deferred.push(() => resolve({ items: [row(q)], total: 1 }))
      })
    )
    await mountHarness(fetcher as never)
    await vi.advanceTimersByTimeAsync(300) // empty-query in flight (deferred[0])

    api.searchTerm.value = 'aaa'
    await vi.advanceTimersByTimeAsync(300) // deferred[1]
    api.searchTerm.value = 'bbb'
    await vi.advanceTimersByTimeAsync(300) // deferred[2]

    // Resolve the OLDER 'aaa' after the newer 'bbb' already started → must be ignored.
    deferred[2]!() // bbb
    deferred[1]!() // aaa (stale — must be ignored)

    await vi.advanceTimersByTimeAsync(10)
    expect(api.items.value.map(r => r.value)).toEqual(['bbb'])
  })

  it('surfaces a fetch error and clears results on the first page', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('boom')
    })
    await mountHarness(fetcher)
    await vi.advanceTimersByTimeAsync(300)
    expect(api.error.value).toBe('boom')
    expect(api.items.value).toEqual([])
    expect(api.loading.value).toBe(false)
  })
})
