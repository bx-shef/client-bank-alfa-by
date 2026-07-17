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
const { poll, syncEnabled, polling, error, message, enabled } = useManualPoll()

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
        variant="soft"
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
          variant="soft"
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
          variant="soft"
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
        @click="poll"
      >
        Опросить сейчас
      </B24Button>
    </div>
  </B24Card>
</template>
