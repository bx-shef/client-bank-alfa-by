<script setup lang="ts">
import { computed } from 'vue'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { splitByDirection } from '~/utils/statement'
import type { StatementItem } from '~/types/statement'

// In-portal statement view. Uses demo data for now; the live Alfa integration
// (backend) replaces MOCK_STATEMENT with a real Statement of the same shape.
// TODO(stage 2): replace MOCK_STATEMENT with a reactive Statement from the
// backend (SSG + client-side useFetch). Then wrap the split below in computed().
const statement = MOCK_STATEMENT
const { credits, debits } = splitByDirection(statement.items)

const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Section total label carries the currency (from the operations, not hard-coded
// BYN). Mock statements are single-currency; a mixed-currency account would need
// per-currency grouping — deferred until real data lands.
function totalLabel(items: StatementItem[]): string {
  const sum = items.reduce((acc, i) => acc + i.amount, 0)
  const currency = items[0]?.currency ?? 'BYN'
  return `${money.format(sum)} ${currency}`
}

const date = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
function fmtDate(iso: string): string {
  return date.format(new Date(iso))
}

const sections = computed(() => [
  { key: 'credit', title: 'Приходы', items: credits, total: totalLabel(credits), accent: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'debit', title: 'Расходы', items: debits, total: totalLabel(debits), accent: 'text-rose-600 dark:text-rose-400' }
])
</script>

<template>
  <main class="mx-auto max-w-(--ui-container) px-4 py-8">
    <header class="mb-6">
      <div class="flex items-baseline justify-between gap-4">
        <h1 class="text-2xl font-semibold">
          Выписка по счёту
        </h1>
        <NuxtLink
          to="/settings"
          class="shrink-0 text-sm underline"
        >
          Настройки
        </NuxtLink>
      </div>
      <p class="mt-1 font-mono text-sm text-(--b24ui-color-text-secondary)">
        {{ statement.account }}
      </p>
      <p class="mt-3 inline-block rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
        Демо-данные — интеграция с Альфа-Банком подключается отдельно (backend).
      </p>
    </header>

    <section
      v-for="section in sections"
      :key="section.key"
      class="mb-8"
    >
      <div class="mb-2 flex items-baseline justify-between">
        <h2 class="text-lg font-medium">
          {{ section.title }}
          <span class="text-sm text-(--b24ui-color-text-secondary)">({{ section.items.length }})</span>
        </h2>
        <span
          class="font-mono text-sm font-semibold"
          :class="section.accent"
        >
          {{ section.total }}
        </span>
      </div>

      <p
        v-if="section.items.length === 0"
        class="text-sm text-(--b24ui-color-text-secondary)"
      >
        Нет операций.
      </p>

      <ul
        v-else
        class="space-y-2"
      >
        <li
          v-for="item in section.items"
          :key="item.docId"
          class="rounded-xl border border-(--b24ui-color-design-tinted-na-stroke) p-4"
        >
          <div class="flex items-baseline justify-between gap-4">
            <span class="font-medium">{{ item.counterparty.name }}</span>
            <span
              class="shrink-0 font-mono font-semibold"
              :class="section.accent"
            >
              {{ money.format(item.amount) }} {{ item.currency }}
            </span>
          </div>
          <p class="mt-1 text-sm text-(--b24ui-color-text-secondary)">
            {{ item.purpose }}
          </p>
          <p class="mt-2 text-xs text-(--b24ui-color-text-secondary)">
            УНП {{ item.counterparty.unp }} · {{ fmtDate(item.acceptDate) }}
            <span v-if="item.docNum"> · док. №{{ item.docNum }}</span>
          </p>
        </li>
      </ul>
    </section>
  </main>
</template>
