<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CheckIcon from '@bitrix24/b24icons-vue/main/CheckIcon'
import RefreshIcon from '@bitrix24/b24icons-vue/outline/RefreshIcon'
import AlertIcon from '@bitrix24/b24icons-vue/outline/AlertIcon'
import type { ImportRunSummary } from '~/types/importStatus'
import { formatRelativeTime, importStateMeta } from '~/utils/importStatus'

// Trust bar: one glance tells "alive / when updated / what reached people".
// Colour = instant verdict. Presentational — the page owns the data.
const props = defineProps<{ status: ImportRunSummary }>()

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
    return `Обновлено ${formatRelativeTime(s.lastSyncAt, now.value)}`
  }
  return meta.value.label
})

const absoluteTime = computed(() =>
  props.status.lastSyncAt
    ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(props.status.lastSyncAt))
    : ''
)

// "+N новых операций" / "Новых операций нет".
const operationsLine = computed(() =>
  props.status.operations > 0
    ? `+${props.status.operations} ${pluralOps(props.status.operations)}`
    : 'Новых операций нет'
)
function pluralOps(n: number): string {
  const last = n % 10
  const tens = n % 100
  if (tens > 10 && tens < 20) return 'новых операций'
  if (last === 1) return 'новая операция'
  if (last > 1 && last < 5) return 'новых операции'
  return 'новых операций'
}

// "Записано в CRM · N уведомления в чат" — confirms the chain reached the end.
const chainLine = computed(() => {
  const s = props.status
  if (s.state !== 'ok' || s.operations === 0) return ''
  const chat = s.chatNotified > 0 ? ` · ${s.chatNotified} в чат` : ''
  return `Записано в CRM${chat}`
})
</script>

<template>
  <B24Alert
    :icon="icon"
    :color="meta.color"
    variant="soft"
    :title="title"
  >
    <template #description>
      <span :title="absoluteTime">{{ operationsLine }}</span>
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
      <B24Button
        label="Проверить настройки"
        color="air-primary"
        size="sm"
        to="/settings"
      />
    </template>
  </B24Alert>
</template>
