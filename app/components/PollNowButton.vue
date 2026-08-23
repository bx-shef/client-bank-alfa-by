<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useManualPoll } from '~/composables/useManualPoll'
import { dayVerdictMessage, isoDayFromMs, pollDayVerdict } from '~/utils/dayValue'

// Manual «Опросить сейчас» (#54): an admin-only button that triggers an immediate bank poll of the
// portal's connected accounts (for testing/debugging — not to wait for the cron). POST /api/poll-now
// (frame token); the backend enforces the feature flag, admin gate and per-portal cooldown. Gated on
// admin here too (no fail-open flash). Outside the portal frame it's a preview. Mirrors
// BankConnectCard's admin/preview handling.
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
const { poll, syncEnabled, polling, error, message, enabled } = useManualPoll()

const adminChecked = ref(false)

// Точечный забор за выбранный день (#588). ⚠ Именно ОДИН день, а не интервал: интервал — это N
// задач к банку за один клик, то есть нагрузка, которую портал назначал бы себе сам, вопреки
// правилу «частоту регулируем мы» (#54). Кому нужен массовый перезабор — это разворот на своём
// сервере, а не кнопка в чужом облаке.
const day = ref('')
const dayVerdict = computed(() => (day.value ? pollDayVerdict(day.value, isoDayFromMs(Date.now())) : 'malformed'))
const dayError = computed(() => (day.value ? dayVerdictMessage(dayVerdict.value) : ''))
/** Забор доступен только с выбранным и годным днём — дата обязательна. */
const canFetchDay = computed(() => dayVerdict.value === 'ok' && !polling.value)

onMounted(async () => {
  await useB24().init().catch(() => {})
  await nextTick()
  checkAdmin()
  syncEnabled()
  adminChecked.value = true
})
</script>

<template>
  <!-- Withhold until the admin check resolves (no fail-open flash to a non-admin). -->
  <p
    v-if="!adminChecked"
    class="text-sm text-(--ui-color-base-3)"
    role="status"
    aria-live="polite"
    data-testid="poll-checking"
  >
    Проверка доступа…
  </p>

  <!-- Non-admin in the portal: nothing to show (manual poll is an admin/operator action). -->
  <template v-else-if="inPortal && !isAdmin" />

  <B24Card
    v-else
    data-testid="poll-now"
  >
    <template #header>
      <h2 class="font-semibold">
        Опрос банка вручную
      </h2>
    </template>

    <div class="space-y-4">
      <p class="text-sm text-(--ui-color-base-2)">
        Запустить немедленный опрос подключённых счетов, не дожидаясь планового. Для проверки после
        подключения счёта. Частота ограничена — повторный опрос доступен через короткую паузу.
      </p>

      <B24Alert
        v-if="!enabled"
        color="air-primary"
        description="Опрос выполняется внутри портала Bitrix24. Здесь — предпросмотр."
        data-testid="poll-preview-note"
      />

      <div
        role="alert"
        aria-live="assertive"
      >
        <B24Alert
          v-if="error"
          color="air-primary-alert"
          :description="error"
          data-testid="poll-error"
        />
      </div>
      <div
        role="status"
        aria-live="polite"
      >
        <B24Alert
          v-if="!error && message"
          color="air-primary-success"
          :description="message"
          data-testid="poll-message"
        />
      </div>

      <B24Button
        :loading="polling"
        :disabled="polling"
        :aria-busy="polling"
        color="air-primary"
        data-testid="poll-button"
        @click="poll()"
      >
        Опросить сейчас
      </B24Button>

      <!-- ⚠ Забор за день стоит ОТДЕЛЬНЫМ блоком под чертой, а не второй кнопкой в ряд: у кнопок
           разный смысл. «Опросить сейчас» берёт обычное окно и безопасен при случайном клике,
           а забор спрашивает банк про конкретный день — и требует, чтобы день сперва выбрали. -->
      <div class="space-y-3 border-t border-(--ui-color-design-outline-stroke) pt-4">
        <div>
          <h3 class="text-sm font-medium">
            Забрать за конкретный день
          </h3>
          <p class="mt-1 text-sm text-(--ui-color-base-2)">
            Если операции за какой-то день не подтянулись — выберите его и заберите повторно.
            Дубликатов не будет: уже записанные операции приложение узнаёт по самому делу.
            Интервал не поддерживается намеренно — это нагрузка на общий лимит запросов к банку.
          </p>
        </div>

        <B24FormField
          label="День"
          required
          :error="dayError"
          hint="Сегодняшний или прошедший — будущий выбрать нельзя"
        >
          <DayField v-model="day" />
        </B24FormField>

        <B24Button
          :loading="polling"
          :disabled="!canFetchDay"
          :aria-busy="polling"
          color="air-secondary-accent-1"
          data-testid="poll-day-button"
          @click="poll(day)"
        >
          Забрать
        </B24Button>
      </div>
    </div>
  </B24Card>
</template>
