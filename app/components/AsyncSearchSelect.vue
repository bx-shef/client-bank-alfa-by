<script setup lang="ts">
// Reusable server-backed autocomplete select over b24ui SelectMenu. Debounced
// remote search + infinite auto-load (IntersectionObserver sentinel in the menu
// footer). Transport-agnostic: pass a `fetcher` that hits a backend proxy. First
// consumer — the chat picker (#16); reused for company/deal/invoice/user pickers.
//
// Server does the filtering, so `ignore-filter` is set (no local filter fights the
// remote result). Reactive glue is in `~/composables/useRemoteSearch`; pure logic
// (gating, page merge) in `~/utils/remoteSearch`.
import { useTemplateRef } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'
import { useRemoteSearch } from '~/composables/useRemoteSearch'
import type { RemoteSearchFetcher } from '~/utils/remoteSearch'

/** An option row. Free-form beyond the label/value keys so callers can carry
 *  extra fields (avatar, type) for the item slots. */
type Option = Record<string, unknown>

const props = withDefaults(defineProps<{
  /** Server transport: (query, offset, signal) → { items, total }. */
  fetcher: RemoteSearchFetcher<Option>
  /** Object key holding the option's display text. */
  labelKey?: string
  /** Object key holding the option's stored value. */
  valueKey?: string
  /** Minimum chars before a non-empty term searches (empty term ⇒ default list). */
  minChars?: number
  /** Keystroke debounce, ms. */
  debounceMs?: number
  placeholder?: string
  disabled?: boolean
}>(), {
  labelKey: 'label',
  valueKey: 'value',
  minChars: 3,
  debounceMs: 250,
  placeholder: 'Начните вводить…',
  disabled: false
})

/** Selected value (the `valueKey` of the chosen option), or undefined. */
const model = defineModel<string | undefined>()

const { searchTerm, items, loading, error, tooShort, hasMore, loadMore, refresh } = useRemoteSearch<Option>({
  fetcher: props.fetcher,
  keyOf: item => String(item[props.valueKey]),
  minChars: props.minChars,
  debounceMs: props.debounceMs
})

// Auto-load: when the footer sentinel scrolls into view and more pages exist,
// pull the next one. loadMore() self-guards against loading / no-more.
const sentinel = useTemplateRef<HTMLElement>('sentinel')
useIntersectionObserver(sentinel, ([entry]) => {
  if (entry?.isIntersecting && hasMore.value && !loading.value) loadMore()
})

// Min-chars hint text (e.g. "Введите ещё N символов").
const hint = () => `Введите ещё ${Math.max(1, props.minChars - searchTerm.value.trim().length)} символ(а)`

// Expose refresh (retry after error) for consumers/tests.
defineExpose({ refresh })
</script>

<template>
  <B24SelectMenu
    v-model="model"
    v-model:search-term="searchTerm"
    :items="items"
    :loading="loading"
    ignore-filter
    :label-key="labelKey"
    :value-key="valueKey"
    :placeholder="placeholder"
    :disabled="disabled"
    reset-search-term-on-blur
    class="w-full"
  >
    <!-- Footer: search state + the auto-load sentinel. -->
    <template #content-bottom>
      <div class="px-2 py-1.5 text-xs text-(--ui-color-base-3)">
        <p
          v-if="tooShort"
          data-testid="too-short"
        >
          {{ hint() }}
        </p>
        <div
          v-else-if="error"
          class="flex items-center justify-between gap-2"
          data-testid="search-error"
        >
          <span class="text-(--ui-color-accent-danger-1)">{{ error }}</span>
          <B24Button
            size="xs"
            color="air-secondary-no-accent"
            label="Повторить"
            @click="refresh()"
          />
        </div>
        <p
          v-else-if="!loading && items.length === 0"
          data-testid="empty"
        >
          Ничего не найдено
        </p>
        <!-- Sentinel: visible only when more pages exist; its appearance in the
             viewport triggers the next page. -->
        <div
          v-if="hasMore"
          ref="sentinel"
          data-testid="load-more-sentinel"
          class="h-1"
        />
      </div>
    </template>
  </B24SelectMenu>
</template>
