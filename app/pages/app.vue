<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SettingsIcon from '@bitrix24/b24icons-vue/outline/SettingsIcon'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { splitByDirection } from '~/utils/statement'
import type { OperationDirection } from '~/types/statement'
import { useB24 } from '~/composables/useB24'
import { useImportStatus } from '~/composables/useImportStatus'
import { useAppSettings } from '~/composables/useAppSettings'
import { pageTitle } from '~/utils/landing'

// In-portal page: `clear` layout wraps it in <B24App> so b24ui theming/colorMode
// work inside the iframe; standalone (direct URL) it just renders the same UI.
definePageMeta({ layout: 'clear' })

useHead({ title: pageTitle('Выписка по счёту') })

const statement = MOCK_STATEMENT
const { credits, debits } = splitByDirection(statement.items)

// Filter chips (labels keep the "(N)" counts). Default "all" shows everything.
type Filter = 'all' | OperationDirection
const filter = ref<Filter>('all')
const chips = computed(() => [
  { value: 'all' as Filter, label: `Все (${statement.items.length})` },
  { value: 'credit' as Filter, label: `Приходы (${credits.length})` },
  { value: 'debit' as Filter, label: `Расходы (${debits.length})` }
])
const shown = computed(() =>
  filter.value === 'all' ? statement.items : statement.items.filter(i => i.direction === filter.value)
)

// Section totals (kept from the previous design — a quick "сколько пришло/ушло").
const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const currency = computed(() => statement.items[0]?.currency ?? 'BYN')
const sum = (items: typeof statement.items) => items.reduce((acc, i) => acc + i.amount, 0)
const creditTotal = computed(() => `+${money.format(sum(credits))} ${currency.value}`)
const debitTotal = computed(() => `−${money.format(sum(debits))} ${currency.value}`)

// Pagination (renders only when it overflows a page).
const perPage = 10
const page = ref(1)
const paged = computed(() => shown.value.slice((page.value - 1) * perPage, page.value * perPage))
function setFilter(f: Filter) {
  filter.value = f
  page.value = 1
}

// Settings slideover (primary entry; /settings route is the fallback).
const settingsOpen = ref(false)

// Import status (demo until the backend poller, #5). Client fetches on mount.
const { status, refresh } = useImportStatus()

// App-level test setting (app.option via backend) — works inside a portal.
const appSettings = useAppSettings()

const b24 = useB24()
onMounted(async () => {
  await refresh()
  await b24.init()
  if (!b24.isInit()) return
  await appSettings.load()
  try {
    const $b24 = b24.getOrThrow()
    await $b24.parent.setTitle('Выписка по счёту')
    await $b24.parent.fitWindow()
  } catch (e) {
    if (import.meta.dev) console.warn('[app] B24 parent calls failed', e)
  }
})
</script>

<template>
  <main class="mx-auto max-w-(--ui-container) px-4 py-6">
    <h1 class="sr-only">
      Выписка по счёту
    </h1>

    <ImportStatusBanner
      :status="status"
      class="mb-5"
    />

    <header class="mb-5 flex items-start justify-between gap-4">
      <p class="font-mono text-sm text-(--ui-color-base-3)">
        {{ statement.account }}
      </p>
      <B24Button
        :icon="SettingsIcon"
        color="air-tertiary-no-accent"
        size="sm"
        aria-label="Настройки"
        @click="settingsOpen = true"
      />
    </header>

    <B24Alert
      color="air-primary-warning"
      variant="soft"
      title="Демо-данные"
      description="Реальная выписка появится после подключения банка."
      class="mb-5"
    />

    <!-- Operations, styled like the "Последние операции" view. -->
    <B24Card>
      <template #header>
        <h2 class="font-semibold">
          Последние операции
        </h2>
      </template>

      <!-- Filter chips -->
      <div class="flex flex-wrap gap-2">
        <B24Button
          v-for="c in chips"
          :key="c.value"
          :label="c.label"
          :color="filter === c.value ? 'air-primary' : 'air-tertiary-no-accent'"
          :aria-pressed="filter === c.value"
          size="sm"
          @click="setFilter(c.value)"
        />
      </div>

      <!-- Section totals (a quick sum without opening each operation). -->
      <p class="mt-3 text-sm tabular-nums">
        <span class="text-emerald-600 dark:text-emerald-400">Приходы {{ creditTotal }}</span>
        <span class="mx-2 text-(--ui-color-base-4)">·</span>
        <span class="text-rose-600 dark:text-rose-400">Расходы {{ debitTotal }}</span>
      </p>

      <!-- Column header -->
      <div class="mt-4 flex items-center justify-between border-b border-(--ui-color-design-tinted-na-stroke) pb-2 text-xs text-(--ui-color-base-3)">
        <span>Операция</span>
        <span>Сумма</span>
      </div>

      <OperationList :items="paged" />

      <!-- Pagination shows only when operations overflow a page — with the current
           demo data (few ops) it stays hidden; visible once the bank is connected. -->
      <B24Pagination
        v-if="shown.length > perPage"
        v-model:page="page"
        :total="shown.length"
        :items-per-page="perPage"
        class="mt-4 justify-center"
      />
    </B24Card>

    <!-- App-level test setting (app.option). Skeleton check that the server can
         persist a per-portal value; visible only inside a portal. -->
    <B24Card class="mt-6">
      <template #header>
        <h2 class="font-semibold">
          Тестовая настройка (уровень приложения)
        </h2>
      </template>

      <p
        v-if="!appSettings.enabled.value"
        class="text-sm text-(--ui-color-base-3)"
      >
        Доступно внутри портала Bitrix24 — значение хранится в настройках приложения (`app.option`).
      </p>

      <div
        v-else
        class="flex flex-col gap-3"
      >
        <div class="flex items-end gap-2">
          <B24Input
            v-model="appSettings.value.value"
            placeholder="Любое значение для проверки"
            class="w-full"
            :disabled="appSettings.loading.value || appSettings.saving.value"
            data-testid="app-setting-input"
          />
          <B24Button
            label="Сохранить"
            color="air-primary"
            :loading="appSettings.saving.value"
            :disabled="appSettings.loading.value"
            @click="appSettings.save()"
          />
        </div>
        <p class="text-xs text-(--ui-color-base-3)">
          Сохранено на портале: <b>{{ appSettings.savedValue.value ?? '—' }}</b>
          · <span class="font-mono">{{ appSettings.domain.value }}</span>
        </p>
        <p
          v-if="appSettings.error.value"
          class="text-xs text-(--ui-color-accent-main-alert)"
        >
          {{ appSettings.error.value }}
        </p>
      </div>
    </B24Card>

    <BuildFooter />

    <!-- Settings slideover (primary entry; /settings route stays as fallback). -->
    <B24Slideover
      v-model:open="settingsOpen"
      title="Настройки"
      description="Уведомления в чат, исключения. Демо: хранится локально."
      side="right"
    >
      <template #body>
        <ClientOnly>
          <SettingsForm />
        </ClientOnly>
      </template>
    </B24Slideover>
  </main>
</template>
