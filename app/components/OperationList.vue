<script setup lang="ts">
import { computed } from 'vue'
import ArrowTopSIcon from '@bitrix24/b24icons-vue/outline/ArrowTopSIcon'
import ArrowDownSIcon from '@bitrix24/b24icons-vue/outline/ArrowDownSIcon'
import EmptyMessageIcon from '@bitrix24/b24icons-vue/outline/EmptyMessageIcon'
import type { StatementItem } from '~/types/statement'

// Statement operations as a compact, scannable list (modelled on the Bitrix24 /
// Alfa "Последние операции" view): rows grouped by day, a direction tile
// (↑ приход / ↓ расход), counterparty + purpose, the amount as the coloured
// accent, and a row that expands to the operation's requisites.
const props = defineProps<{ items: StatementItem[] }>()

const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const groupFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' })
const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

function dayKey(iso: string): string {
  return iso.slice(0, 10) // YYYY-MM-DD
}
function fmtGroup(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : groupFmt.format(t)
}
function fmtDateTime(iso: string): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : dateTimeFmt.format(t)
}

/** Direction presentation: icon, tint classes, and the signed amount. */
function meta(item: StatementItem) {
  const credit = item.direction === 'credit'
  return {
    icon: credit ? ArrowTopSIcon : ArrowDownSIcon,
    tile: credit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
    amount: `${credit ? '+' : '−'}${money.format(item.amount)} ${item.currency}`
  }
}

/** Requisites shown when a row is expanded (empty fields dropped). */
function requisites(item: StatementItem) {
  return [
    { label: 'Корреспондент', description: item.counterparty.name, orientation: 'horizontal' as const },
    { label: 'Счёт корреспондента', description: item.counterparty.account, orientation: 'horizontal' as const },
    { label: 'УНП', description: item.counterparty.unp, orientation: 'horizontal' as const },
    { label: 'Банк корреспондента', description: item.counterparty.bank, orientation: 'horizontal' as const },
    { label: 'Наш счёт', description: item.account, orientation: 'horizontal' as const },
    { label: 'Дата операции', description: fmtDateTime(item.acceptDate), orientation: 'horizontal' as const },
    { label: '№ документа', description: item.docNum || item.docId, orientation: 'horizontal' as const },
    { label: 'Код операции', description: item.operCodeName, orientation: 'horizontal' as const },
    { label: 'Назначение', description: item.purpose, orientation: 'horizontal' as const }
  ].filter(r => r.description)
}

/** Items grouped by day, newest first. */
const groups = computed(() => {
  const byDay = new Map<string, StatementItem[]>()
  for (const item of [...props.items].sort((a, b) => b.acceptDate.localeCompare(a.acceptDate))) {
    const key = dayKey(item.acceptDate)
    ;(byDay.get(key) ?? byDay.set(key, []).get(key)!).push(item)
  }
  return [...byDay.entries()].map(([key, items]) => ({ key, label: fmtGroup(items[0]!.acceptDate), items }))
})

const hasItems = computed(() => props.items.length > 0)
</script>

<template>
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

  <div v-else>
    <div
      v-for="group in groups"
      :key="group.key"
    >
      <!-- Day header -->
      <p class="rounded-md bg-(--ui-color-design-tinted-na-bg) px-3 py-1 text-xs font-medium text-(--ui-color-base-3)">
        {{ group.label }}
      </p>

      <B24Collapsible
        v-for="item in group.items"
        :key="item.docId"
        class="border-b border-(--ui-color-design-tinted-na-stroke) last:border-b-0"
      >
        <!-- Row (trigger) -->
        <div class="flex w-full cursor-pointer items-center gap-3 py-3 text-left transition-colors hover:bg-(--ui-color-design-tinted-na-bg)">
          <span
            class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-(--ui-color-design-tinted-na-bg)"
            :class="meta(item).tile"
          >
            <component
              :is="meta(item).icon"
              class="size-4"
            />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-semibold">
              {{ item.counterparty.name }}
            </p>
            <p class="truncate text-xs text-(--ui-color-base-3)">
              {{ item.purpose }}
            </p>
          </div>
          <span
            class="shrink-0 font-semibold tabular-nums"
            :class="meta(item).tile"
          >
            {{ meta(item).amount }}
          </span>
        </div>

        <template #content>
          <B24DescriptionList
            :items="requisites(item)"
            size="sm"
            class="pb-3 pl-12"
          />
        </template>
      </B24Collapsible>
    </div>
  </div>
</template>
