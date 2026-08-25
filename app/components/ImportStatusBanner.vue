<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CheckIcon from '@bitrix24/b24icons-vue/main/CheckIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import AlertIcon from '@bitrix24/b24icons-vue/outline/AlertIcon'
import type { ImportRunSummary } from '~/types/importStatus'
import { formatRelativeTime, importStateMeta, pluralRu } from '~/utils/importStatus'

// Trust bar: one glance tells "alive / when updated / what reached people".
// Colour = instant verdict. Presentational — the page owns the data.
const props = defineProps<{ status: ImportRunSummary }>()
/** Открыть настройки просим страницу-владельца: как именно (слайдер портала или обычная
 *  навигация) — решает она, компонент об этом знать не должен. */
const emit = defineEmits<{ openSettings: [] }>()

// `now` is set on mount (client) so relative time is fresh and never causes an
// SSR/CSR hydration mismatch (server renders with now=0 → the "never" branch).
const now = ref(0)
onMounted(() => {
  now.value = Date.now()
})

const meta = computed(() => importStateMeta(props.status.state))
const icon = computed(() => {
  switch (props.status.state) {
    case 'ok': return CheckIcon
    case 'running': return RefreshIcon
    case 'error': return AlertIcon
    default: return RefreshIcon
  }
})

const title = computed(() => {
  const s = props.status
  if (s.state === 'ok' && s.lastSyncAt && now.value) {
    // ⚠ «Последние движения», а НЕ «Обновлено» (#37): метка ставится только когда прогон дал
    // операции, поэтому «обновлено N назад» читалось как «опрос был N назад» и путало с частотой
    // опроса (она своя — CRON_INTERVAL_MIN). Честнее сказать, когда были последние движения.
    return `Последние движения — ${formatRelativeTime(s.lastSyncAt, now.value)}`
  }
  return meta.value.label
})

const absoluteTime = computed(() =>
  props.status.lastSyncAt
    ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(props.status.lastSyncAt))
    : ''
)

// "+N движений по счёту" / "Новых движений нет" (#37 — «движения» понятнее бухгалтеру, чем
// техническое «операции»). Reuses the tested pluralRu helper.
const operationsLine = computed(() => {
  const n = props.status.operations
  if (n <= 0) return 'Новых движений по счёту нет'
  return `+${n} ${pluralRu(n, ['движение', 'движения', 'движений'])} по счёту`
})

// "Записаны в CRM · N уведомлений в чат" — что именно доехало до людей (#37).
// ⚠ «уведомление в чат», а не голое «N в чат»: число рядом с «записано в CRM» читалось как «часть
// ушла НЕ в CRM». Это уведомления в ЧАТ УВЕДОМЛЕНИЙ — не проблемы (те идут в чат ошибок отдельно).
const chainLine = computed(() => {
  const s = props.status
  if (s.state !== 'ok' || s.operations === 0) return ''
  const chat = s.chatNotified > 0
    ? ` · ${s.chatNotified} ${pluralRu(s.chatNotified, ['уведомление', 'уведомления', 'уведомлений'])} в чат`
    : ''
  return `Записаны в CRM${chat}`
})
</script>

<template>
  <B24Alert
    :icon="icon"
    :color="meta.color"
    role="status"
    aria-live="polite"
  >
    <!-- Relative time is the headline; exact time on hover (tooltip). -->
    <template #title>
      <span :title="absoluteTime">{{ title }}</span>
    </template>
    <template #description>
      <span>{{ operationsLine }}</span>
      <span v-if="chainLine"> · {{ chainLine }}</span>
      <template v-if="status.state === 'error' && status.errors.length">
        <br>
        <span>{{ status.errors[0] }}</span>
      </template>
    </template>

    <template
      v-if="status.state === 'error'"
      #actions
    >
      <!-- Просим страницу открыть настройки. -->
      <B24Button
        label="Проверить настройки"
        color="air-primary"
        size="sm"
        @click="emit('openSettings')"
      />
    </template>
  </B24Alert>
</template>
