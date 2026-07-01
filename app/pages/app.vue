<script setup lang="ts">
import { computed, onMounted } from 'vue'
import SettingsIcon from '@bitrix24/b24icons-vue/outline/SettingsIcon'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { splitByDirection } from '~/utils/statement'
import type { StatementItem } from '~/types/statement'
import { useB24 } from '~/composables/useB24'
import { useImportStatus } from '~/composables/useImportStatus'
import { useAppSettings } from '~/composables/useAppSettings'

// In-portal page: `clear` layout wraps it in <B24App> so b24ui theming/colorMode
// work inside the iframe; standalone (direct URL) it just renders the same UI.
definePageMeta({ layout: 'clear' })

// Document title for standalone; in the portal parent.setTitle sets the iframe chrome.
useHead({ title: 'Выписка по счёту — Клиент-банк Альфа-Банк Беларусь' })

const statement = MOCK_STATEMENT
const { credits, debits } = splitByDirection(statement.items)

const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
function totalLabel(items: StatementItem[]): string {
  const sum = items.reduce((acc, i) => acc + i.amount, 0)
  const currency = items[0]?.currency ?? 'BYN'
  return `${money.format(sum)} ${currency}`
}

const creditAccent = 'text-emerald-600 dark:text-emerald-400'
const debitAccent = 'text-rose-600 dark:text-rose-400'

const tabs = computed(() => [
  { label: `Приходы (${credits.length})`, slot: 'credit' as const },
  { label: `Расходы (${debits.length})`, slot: 'debit' as const }
])

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
    <!-- Heading kept for a11y/standalone; the portal shows it as iframe chrome
         (parent.setTitle), so it's visually hidden to keep the screen calm. -->
    <h1 class="sr-only">
      Выписка по счёту
    </h1>

    <ImportStatusBanner
      :status="status"
      class="mb-5"
    />

    <header class="mb-5 flex items-start justify-between gap-4">
      <div>
        <p class="font-mono text-sm text-(--ui-color-base-3)">
          {{ statement.account }}
        </p>
      </div>
      <B24Button
        :icon="SettingsIcon"
        color="air-tertiary-no-accent"
        size="sm"
        to="/settings"
        aria-label="Настройки"
      />
    </header>

    <B24Alert
      color="air-primary-warning"
      variant="soft"
      title="Демо-данные"
      description="Реальная выписка появится после подключения банка."
      class="mb-5"
    />

    <B24Tabs
      :items="tabs"
      color="air-primary"
    >
      <template #credit>
        <OperationList
          :items="credits"
          :accent="creditAccent"
          :total="totalLabel(credits)"
        />
      </template>
      <template #debit>
        <OperationList
          :items="debits"
          :accent="debitAccent"
          :total="totalLabel(debits)"
        />
      </template>
    </B24Tabs>

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
  </main>
</template>
