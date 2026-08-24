<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useManualPoll } from '~/composables/useManualPoll'

// Manual «Опросить сейчас» (#54): an admin-only button that triggers an immediate bank poll of the
// portal's connected accounts (for testing/debugging — not to wait for the cron). POST /api/poll-now
// (frame token); the backend enforces the feature flag, admin gate and per-portal cooldown. Gated on
// admin here too (no fail-open flash). Outside the portal frame it's a preview. Mirrors
// BankConnectCard's admin/preview handling.
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
const { poll, syncEnabled, polling, error, message, enabled, outcome, waiting } = useManualPoll()

const adminChecked = ref(false)

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

      <!-- ⚠ Кнопки заблокированы и на время ОЖИДАНИЯ исхода, а не только запроса: `polling`
           гаснет сразу после ответа сервера, и второе нажатие запускало бы второй цикл ожидания
           поверх первого. -->
      <B24Button
        :loading="polling || waiting"
        :disabled="polling || waiting"
        :aria-busy="polling || waiting"
        color="air-primary"
        data-testid="poll-button"
        @click="poll()"
      >
        Опросить сейчас
      </B24Button>

      <!-- ⚠ Исход прогона показываем ЗДЕСЬ, ОБЩИМ для обеих кнопок и ВЫШЕ раздела про день:
           «Опросить сейчас» тоже дожидается исхода, а под заголовком «Забрать за конкретный день»
           его результат читался бы как ответ про выбранную дату. Без этого блока кнопка отвечала
           «опрос запущен» и замолкала навсегда, и отличить «банк вернул ноль» от «кнопка не
           работает» человек в портале не мог никак. -->
      <div
        role="status"
        aria-live="polite"
      >
        <p
          v-if="waiting"
          class="text-sm text-(--ui-color-base-3)"
          data-testid="poll-waiting"
        >
          Ждём ответа банка…
        </p>
        <B24Alert
          v-else-if="outcome"
          color="air-primary-success"
          :description="outcome"
          data-testid="poll-outcome"
        />
      </div>

      <!-- ⚠ Забора за конкретный день здесь БОЛЬШЕ НЕТ (#19): он переехал в строку подключения, к
           кнопке «Забрать за день». Причина не в раскладке — здесь у действия не было АДРЕСА: оно
           ставило задачу на КАЖДЫЙ подключённый счёт портала, тогда как человек смотрел на
           конкретную строку и про неё спрашивал. На портале с двумя банками ответ «опрос запущен»
           не говорил, что именно опрошено, а лимит запросов тратился на счета, о которых не
           спрашивали. Возвращать поле сюда — значит вернуть безадресность. -->
    </div>
  </B24Card>
</template>
