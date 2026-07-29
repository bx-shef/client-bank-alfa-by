<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useSetupStatus } from '~/composables/useSetupStatus'
import { useChatSettings } from '~/composables/useChatSettings'
import { buildReadiness, isFullyReady, nextPollAt } from '~/utils/setupReadiness'
import { formatRelativeTime } from '~/utils/importStatus'

// «Что настроено, а что нет» — the first thing in the settings (#409/#405).
//
// Before this, a half-configured portal looked completely normal: the bank card, the chat picker and
// the smart-process button each knew their own state and none of them said whether the app would
// actually do anything. The schedule was nowhere at all, so «почему ничего не приходит?» had no
// answer on screen.
//
// Composition is deliberate: portal settings come from the shared singleton the form already uses,
// server facts from /api/setup-status. Joining them here (not on the server) keeps one source of
// truth for settings — a server copy could disagree with the form the admin is editing.

const setup = useSetupStatus()
const chatSettings = useChatSettings()

const items = computed(() => buildReadiness({
  settings: chatSettings.settings,
  connectedAccounts: setup.status.value.connectedAccounts,
  pollEnabled: setup.status.value.pollEnabled,
  pollIntervalMin: setup.status.value.pollIntervalMin,
  lastRunMs: setup.status.value.lastRunMs
}))

const ready = computed(() => isFullyReady(items.value))
const pending = computed(() => items.value.filter(i => !i.ok).length)

/** «следующий опрос ≈ через N минут» — null while polling is off or nothing has run yet. */
const nextPoll = computed(() => {
  const at = nextPollAt({
    settings: chatSettings.settings,
    connectedAccounts: setup.status.value.connectedAccounts,
    pollEnabled: setup.status.value.pollEnabled,
    pollIntervalMin: setup.status.value.pollIntervalMin,
    lastRunMs: setup.status.value.lastRunMs
  })
  return at === null ? '' : formatRelativeTime(new Date(at).toISOString(), Date.now())
})

const lastRun = computed(() => {
  const ms = setup.status.value.lastRunMs
  return ms === null ? '' : formatRelativeTime(new Date(ms).toISOString(), Date.now())
})

onMounted(async () => {
  await setup.load()
  // Settings may already be loaded by the form; load() is idempotent and cheap.
  await chatSettings.load()
})
</script>

<template>
  <B24Card data-testid="setup-readiness">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <h2 class="font-semibold">
          Готовность к работе
        </h2>
        <B24Badge
          v-if="setup.loaded.value"
          :color="ready ? 'air-primary-success' : 'air-primary-warning'"
          size="xs"
          :label="ready ? 'всё настроено' : `осталось: ${pending}`"
          data-testid="readiness-badge"
        />
      </div>
    </template>

    <p
      v-if="!setup.loaded.value"
      class="text-sm text-(--ui-color-base-3)"
      role="status"
      aria-live="polite"
    >
      Проверяем настройку…
    </p>

    <template v-else>
      <div
        role="alert"
        aria-live="assertive"
      >
        <B24Alert
          v-if="setup.error.value"
          color="air-primary-alert"
          variant="soft"
          :description="setup.error.value"
          class="mb-3"
          data-testid="readiness-error"
        />
      </div>

      <ul class="space-y-3">
        <li
          v-for="i in items"
          :key="i.key"
          class="flex gap-3"
          :data-testid="`readiness-${i.key}`"
        >
          <!-- Never colour alone: the ✓/! glyph and the wording carry the state too. -->
          <span
            class="mt-0.5 shrink-0 text-sm font-bold"
            :class="i.ok ? 'text-(--ui-color-accent-main-success)' : 'text-(--ui-color-accent-main-warning)'"
            aria-hidden="true"
          >{{ i.ok ? '✓' : '!' }}</span>
          <div class="min-w-0">
            <div class="text-sm font-medium">
              {{ i.title }} — <span class="font-normal text-(--ui-color-base-3)">{{ i.detail }}</span>
              <span class="sr-only">{{ i.ok ? '(настроено)' : '(не настроено)' }}</span>
            </div>
            <p
              v-if="i.hint"
              class="text-xs text-(--ui-color-base-3)"
            >
              {{ i.hint }}
            </p>
          </div>
        </li>
      </ul>

      <!-- Schedule (#405): the question «а когда оно само сходит в банк?» had no answer anywhere. -->
      <div class="mt-4 border-t border-(--ui-color-design-tinted-na-stroke) pt-3 text-xs text-(--ui-color-base-3)">
        <p v-if="lastRun">
          Последний опрос: {{ lastRun }}.
          <template v-if="nextPoll">
            Следующий ориентировочно {{ nextPoll }}.
          </template>
        </p>
        <p v-else-if="setup.status.value.pollEnabled">
          Опросов ещё не было — первый пройдёт в течение
          {{ setup.status.value.pollIntervalMin }} мин после подключения счёта.
        </p>
        <p v-else>
          Автоматический опрос выключен, выписка не забирается сама. Ручная загрузка файла работает всегда.
        </p>
      </div>
    </template>
  </B24Card>
</template>
