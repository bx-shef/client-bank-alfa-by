// Reactive orchestration for remote autocomplete: debounces the search term,
// runs the injected fetcher, tracks loading/error/hasMore, and appends pages on
// "load more". Pure decisions (term gating, page merge, more-math) come from
// `~/utils/remoteSearch`; this file owns only the reactive glue + request race.
//
// Transport-agnostic by design: the fetcher is injected, so the same composable
// backs a chat picker (im.search.chat.list via backend proxy), a company/deal/
// invoice picker, etc. UI wrapper is `AsyncSearchSelect.vue`.

import { computed, ref, shallowRef, watch } from 'vue'
import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { refDebounced } from '@vueuse/core'
import {
  hasMoreResults,
  isQueryReady,
  mergePages,
  normalizeSearchTerm,
  type RemoteSearchFetcher
} from '~/utils/remoteSearch'

export interface UseRemoteSearchOptions<T> {
  /** Server transport: (query, offset, signal) → page. */
  fetcher: RemoteSearchFetcher<T>
  /** Stable identity of a row (for de-dup across pages). */
  keyOf: (item: T) => string
  /** Minimum chars before a non-empty term searches. Default 3. */
  minChars?: number
  /** Debounce for keystrokes, ms. Default 250. */
  debounceMs?: number
}

export interface UseRemoteSearch<T> {
  /** Bound to the select's search input (`v-model:search-term`). */
  searchTerm: Ref<string>
  /** Accumulated results (grows on load-more, resets on a new query). */
  items: ShallowRef<T[]>
  /** A request is in flight. */
  loading: Ref<boolean>
  /** Last error message, or null. */
  error: Ref<string | null>
  /** True while the term is non-empty but shorter than `minChars`. */
  tooShort: ComputedRef<boolean>
  /** More pages exist on the server. */
  hasMore: ComputedRef<boolean>
  /** Append the next page for the current term. No-op if loading / no more. */
  loadMore: () => Promise<void>
  /** Re-run the current term from offset 0 (e.g. retry after error). */
  refresh: () => Promise<void>
}

export function useRemoteSearch<T>(options: UseRemoteSearchOptions<T>): UseRemoteSearch<T> {
  const minChars = options.minChars ?? 3
  const debounceMs = options.debounceMs ?? 250

  const searchTerm = ref('')
  const debounced = refDebounced(searchTerm, debounceMs)

  const items = shallowRef<T[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const total = ref(0)

  const normalized = computed(() => normalizeSearchTerm(debounced.value ?? ''))
  const tooShort = computed(() => !isQueryReady(normalized.value, minChars))
  const hasMore = computed(() => hasMoreResults(items.value.length, total.value))

  // Request race guard: each run bumps a token; a response whose token is stale
  // (a newer query started meanwhile) is dropped. AbortController cancels the
  // in-flight fetch when possible so the backend isn't queried needlessly.
  let runToken = 0
  let inFlight: AbortController | null = null

  async function run(term: string, offset: number): Promise<void> {
    // Gate: too-short terms never hit the network — clear to an empty list.
    if (!isQueryReady(term, minChars)) {
      inFlight?.abort()
      inFlight = null
      runToken++
      items.value = []
      total.value = 0
      loading.value = false
      error.value = null
      return
    }
    const token = ++runToken
    inFlight?.abort()
    const ctrl = new AbortController()
    inFlight = ctrl
    loading.value = true
    error.value = null
    try {
      const page = await options.fetcher(term, offset, ctrl.signal)
      if (token !== runToken) return // superseded by a newer query — drop
      items.value = offset === 0 ? page.items : mergePages(items.value, page.items, options.keyOf)
      total.value = page.total
    } catch (e) {
      if (token !== runToken) return // stale error — ignore
      if ((e as Error)?.name === 'AbortError') return
      error.value = (e as Error)?.message || 'Ошибка поиска'
      if (offset === 0) {
        items.value = []
        total.value = 0
      }
    } finally {
      if (token === runToken) loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (loading.value || !hasMore.value) return
    await run(normalized.value, items.value.length)
  }

  async function refresh(): Promise<void> {
    await run(normalized.value, 0)
  }

  // New (debounced) term ⇒ fresh search from offset 0.
  watch(normalized, term => run(term, 0), { immediate: true })

  return { searchTerm, items, loading, error, tooShort, hasMore, loadMore, refresh }
}
