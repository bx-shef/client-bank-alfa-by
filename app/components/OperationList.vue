<script setup lang="ts">
import EmptyMessageIcon from '@bitrix24/b24icons-vue/outline/EmptyMessageIcon'
import type { StatementItem } from '~/types/statement'

// One section of the statement (credits or debits). Card per operation; a calm
// empty state. The amount is the only coloured accent. (Skeleton/loading lands
// with the live statement fetch — #5.)
const props = defineProps<{
  items: StatementItem[]
  /** Tailwind colour classes for the amount (the single accent per card). */
  accent: string
  /** Total line for the section (already formatted, e.g. "2 160,50 BYN"). */
  total: string
}>()

const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
function fmtDate(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : dateFmt.format(t)
}
const hasItems = computed(() => props.items.length > 0)
</script>

<template>
  <div>
    <p
      class="mb-3 text-xl font-semibold tabular-nums"
      :class="accent"
    >
      {{ total }}
    </p>

    <!-- Empty: calm, not alarming. -->
    <div
      v-if="!hasItems"
      class="flex flex-col items-center gap-2 py-10 text-center"
    >
      <EmptyMessageIcon class="size-8 text-(--ui-color-base-4)" />
      <p class="font-medium">
        Пока пусто
      </p>
      <p class="text-sm text-(--ui-color-base-3)">
        Операции появятся после первой синхронизации.
      </p>
    </div>

    <div
      v-else
      class="space-y-3"
    >
      <B24Card
        v-for="item in items"
        :key="item.docId"
      >
        <div class="flex items-baseline justify-between gap-4">
          <span class="font-semibold">{{ item.counterparty.name }}</span>
          <span
            class="shrink-0 font-semibold tabular-nums"
            :class="accent"
          >
            {{ money.format(item.amount) }} {{ item.currency }}
          </span>
        </div>
        <p class="mt-1 line-clamp-2 text-sm text-(--ui-color-base-3)">
          {{ item.purpose }}
        </p>
        <p class="mt-2 text-xs text-(--ui-color-base-4)">
          УНП {{ item.counterparty.unp }} · {{ fmtDate(item.acceptDate) }}<span v-if="item.docNum"> · № {{ item.docNum }}</span>
        </p>
      </B24Card>
    </div>
  </div>
</template>
