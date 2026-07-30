<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSetupStatus } from '~/composables/useSetupStatus'
import { useChatSettings } from '~/composables/useChatSettings'
import { buildReadiness, isFullyReady } from '~/utils/setupReadiness'
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

/** In-portal only. Outside the frame there is no token, so the server half is unknown — stating
 *  «осталось: 4» there would be a confident claim about a portal we never queried. Comes from
 *  useSetupStatus (its own frameAuth read), not from the settings singleton, whose flag only flips
 *  after ITS load — a child mounts before its parent, so borrowing it would flash a false preview. */
const inFrame = computed(() => setup.inFrame.value)

const items = computed(() => buildReadiness({
  settings: chatSettings.settings,
  connectedAccounts: setup.status.value.connectedAccounts,
  pendingAccounts: setup.status.value.pendingAccounts,
  pollEnabled: setup.status.value.pollEnabled,
  pollIntervalMin: setup.status.value.pollIntervalMin,
  lastRunMs: setup.status.value.lastRunMs
}))

const ready = computed(() => isFullyReady(items.value))
const pending = computed(() => items.value.filter(i => !i.ok).length)

// «5 минут назад» — recomputed against a ticking clock, not a `Date.now()` frozen inside a computed
// (a slideover left open would otherwise keep claiming «2 минуты назад» forever).
const nowMs = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const lastRun = computed(() => {
  const ms = setup.status.value.lastRunMs
  return ms === null ? '' : formatRelativeTime(new Date(ms).toISOString(), nowMs.value)
})

/** Re-read the server half. Bound to window focus so returning from the bank tab (a top-level
 *  redirect that never notifies us) doesn't leave the checklist claiming «нет подключений» about
 *  the account the admin just connected. */
function refresh() {
  void setup.load()
}

onMounted(() => {
  void setup.load()
  // Chat settings are NOT loaded here: the parent form already loaded them, and useChatSettings.load()
  // is NOT idempotent — a second call would re-fetch and `Object.assign` the server copy over
  // whatever the admin has typed since, silently discarding edits.
  clock = setInterval(() => (nowMs.value = Date.now()), 30_000)
  if (import.meta.client) window.addEventListener('focus', refresh)
})

onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
  if (import.meta.client) window.removeEventListener('focus', refresh)
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
          v-if="inFrame && setup.loaded.value"
          :color="ready ? 'air-primary-success' : 'air-primary-warning'"
          size="xs"
          :label="ready ? 'всё настроено' : `осталось: ${pending}`"
          data-testid="readiness-badge"
        />
      </div>
    </template>

    <B24Alert
      v-if="!inFrame"
      color="air-primary"
      variant="soft"
      description="Готовность видна внутри портала Bitrix24. Здесь — предпросмотр."
      data-testid="readiness-preview"
    />

    <p
      v-else-if="!setup.loaded.value"
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
        <!-- «Последний ИМПОРТ», не «опрос»: отметку ставит любой прогон crm-sync, включая ручную
             загрузку файла — иначе портал без единого подключения читал бы «последний опрос». -->
        <p v-if="setup.status.value.pollEnabled">
          Опрос банка каждые {{ setup.status.value.pollIntervalMin }} мин.
          <template v-if="lastRun">
            Последний импорт: {{ lastRun }}.
          </template>
          <template v-else>
            Импортов ещё не было.
          </template>
        </p>
        <p v-else>
          Автоматический опрос выключен, выписка не забирается сама. Ручная загрузка файла работает всегда.
        </p>
      </div>
    </template>
  </B24Card>
</template>
