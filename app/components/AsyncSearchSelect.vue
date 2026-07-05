<script setup lang="ts">
// Reusable server-backed autocomplete select over b24ui SelectMenu. Debounced
// remote search + explicit "load more" pagination. Transport-agnostic: pass a
// `fetcher` that hits a backend proxy. First consumer — the chat picker (#16);
// reused for company/deal/invoice/user pickers.
//
// Server does the filtering, so `ignore-filter` is set. Reactive glue is in
// `~/composables/useRemoteSearch`; pure logic (gating, page merge) in
// `~/utils/remoteSearch`. Item slots (avatar/subtitle) and extra props pass
// through to the underlying SelectMenu.
//
// NB pagination is a "Показать ещё" button, not scroll-anchored infinite load:
// b24ui SelectMenu exposes no slot INSIDE its scroll viewport (`content-bottom`
// is a pinned footer), so a scroll sentinel can't be anchored reliably. The
// button is the robust equivalent; revisit if b24ui adds a viewport slot.
import { computed, ref } from 'vue'
import { useRemoteSearch } from '~/composables/useRemoteSearch'
import type { RemoteSearchFetcher } from '~/utils/remoteSearch'

defineOptions({ inheritAttrs: false })

/** An option row. Free-form beyond the label/value keys so callers can carry
 *  extra fields (avatar, type) for the item slots. */
type Option = Record<string, unknown>

const props = withDefaults(defineProps<{
  /** Server transport: (query, offset, signal) → { items, total? | hasMore? }. */
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
  /** The already-selected option, so its label shows on reload even before it
   *  appears in a fetched page (stored value → known label). */
  selectedOption?: Option
}>(), {
  labelKey: 'label',
  valueKey: 'value',
  minChars: 3,
  debounceMs: 250,
  placeholder: 'Начните вводить…',
  disabled: false,
  selectedOption: undefined
})

/** Selected value (the `valueKey` of the chosen option), or undefined. */
const model = defineModel<string | undefined>()

const { searchTerm, items, loading, error, tooShort, hasMore, loadMore, refresh } = useRemoteSearch<Option>({
  fetcher: props.fetcher,
  keyOf: item => String(item[props.valueKey]),
  minChars: props.minChars,
  debounceMs: props.debounceMs,
  immediate: false // fetch the default list lazily, on first open (below)
})

// Seed the selected option into the list so its label survives a result-set that
// no longer contains it (e.g. after a narrower search or on reload).
const displayItems = computed<Option[]>(() => {
  const sel = props.selectedOption
  if (!sel) return items.value
  const v = String(sel[props.valueKey])
  return items.value.some(i => String(i[props.valueKey]) === v) ? items.value : [sel, ...items.value]
})

// Lazy default list: fetch once when the menu is first opened, not on mount, so
// idle pickers don't each fire a backend request up front.
const loadedOnce = ref(false)
function onOpenChange(open: boolean) {
  if (open && !loadedOnce.value) {
    loadedOnce.value = true
    refresh()
  }
}

// Min-chars hint text (e.g. "Введите ещё N символов").
const hint = computed(() => `Введите ещё ${Math.max(1, props.minChars - searchTerm.value.trim().length)} символ(а)`)

defineExpose({ refresh })
</script>

<template>
  <B24SelectMenu
    v-bind="$attrs"
    v-model="model"
    v-model:search-term="searchTerm"
    :items="displayItems"
    :loading="loading"
    ignore-filter
    :label-key="labelKey"
    :value-key="valueKey"
    :placeholder="placeholder"
    :disabled="disabled"
    class="w-full"
    @update:open="onOpenChange"
  >
    <!-- Forward SelectMenu item slots so consumers can render avatars/subtitles. -->
    <template
      v-for="name in ['item', 'item-leading', 'item-trailing']"
      #[name]="slotProps"
      :key="name"
    >
      <slot
        :name="name"
        v-bind="slotProps"
      />
    </template>

    <!-- Footer: search state + explicit load-more. -->
    <template #content-bottom>
      <div class="px-2 py-1.5 text-xs text-(--ui-color-base-3)">
        <p
          v-if="tooShort"
          data-testid="too-short"
        >
          {{ hint }}
        </p>
        <div
          v-else-if="error"
          class="flex items-center justify-between gap-2"
          data-testid="search-error"
        >
          <span class="text-(--ui-color-accent-main-alert)">{{ error }}</span>
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
        <B24Button
          v-else-if="hasMore"
          block
          size="xs"
          color="air-secondary-no-accent"
          :loading="loading"
          label="Показать ещё"
          data-testid="load-more"
          @click="loadMore()"
        />
      </div>
    </template>
  </B24SelectMenu>
</template>
