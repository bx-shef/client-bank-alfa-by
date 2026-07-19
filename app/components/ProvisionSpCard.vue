<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useProvisionDistribution } from '~/composables/useProvisionDistribution'

// Admin-only «Настроить смарт-процессы распределения» button (#109 §9.1). POST /api/distribution/
// provision (frame token) creates/verifies the two ledger SPs and stores their entityTypeIds. The
// backend enforces the feature flag + admin gate + single-flight; gated on admin here too (no
// fail-open flash). Outside the portal frame it's a preview. Mirrors PollNowButton.
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
const { provision, syncEnabled, provisioning, error, message, enabled } = useProvisionDistribution()

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
    data-testid="provision-checking"
  >
    Проверка доступа…
  </p>

  <!-- Non-admin in the portal: nothing to show (provisioning is an admin action). -->
  <template v-else-if="inPortal && !isAdmin" />

  <B24Card
    v-else
    data-testid="provision-sp"
  >
    <template #header>
      <h2 class="font-semibold">
        Смарт-процессы распределения
      </h2>
    </template>

    <div class="space-y-4">
      <p class="text-sm text-(--ui-color-base-2)">
        Создать (или проверить) два служебных смарт-процесса для учёта распределения платежей —
        «платежи» и «распределения». Приложение хранит в них разнесение оплат вместо своей базы.
        Действие идемпотентно: повторный запуск ничего не дублирует.
      </p>

      <B24Alert
        v-if="!enabled"
        color="air-primary"
        variant="soft"
        description="Настройка выполняется внутри портала Bitrix24. Здесь — предпросмотр."
        data-testid="provision-preview-note"
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
          data-testid="provision-error"
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
          data-testid="provision-message"
        />
      </div>

      <B24Button
        :loading="provisioning"
        :disabled="provisioning"
        :aria-busy="provisioning"
        color="air-primary"
        data-testid="provision-button"
        @click="provision"
      >
        Настроить смарт-процессы
      </B24Button>
    </div>
  </B24Card>
</template>
