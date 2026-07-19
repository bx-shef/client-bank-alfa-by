<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useDistributionLedger } from '~/composables/useDistributionLedger'

// Admin-only «Распределение» tab (#109 §9.3 #4): the portal's payment carriers + their distribution
// rows. GET /api/distribution/ledger (frame token); backend gates on feature flag + admin. Gated on
// admin here too (no fail-open flash). Outside the portal frame it's a preview. Mirrors PollNowButton /
// ProvisionSpCard.
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
const { load, syncEnabled, loading, error, enabled, loaded, provisioned, cards } = useDistributionLedger()

const adminChecked = ref(false)

onMounted(async () => {
  await useB24().init().catch(() => {})
  await nextTick()
  checkAdmin()
  syncEnabled()
  adminChecked.value = true
  if (enabled.value && (!inPortal.value || isAdmin.value)) await load()
})
</script>

<template>
  <!-- Withhold until the admin check resolves (no fail-open flash to a non-admin). -->
  <p
    v-if="!adminChecked"
    class="text-sm text-(--ui-color-base-3)"
    role="status"
    aria-live="polite"
    data-testid="ledger-checking"
  >
    Проверка доступа…
  </p>

  <!-- Non-admin in the portal: nothing to show. -->
  <template v-else-if="inPortal && !isAdmin" />

  <B24Card
    v-else
    data-testid="distribution-tab"
  >
    <template #header>
      <h2 class="font-semibold">
        Распределение платежей
      </h2>
    </template>

    <div class="space-y-4">
      <B24Alert
        v-if="!enabled"
        color="air-primary"
        variant="soft"
        description="Распределение показывается внутри портала Bitrix24. Здесь — предпросмотр."
        data-testid="ledger-preview-note"
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
          data-testid="ledger-error"
        />
      </div>

      <p
        v-if="loading"
        class="text-sm text-(--ui-color-base-3)"
        role="status"
        aria-live="polite"
        data-testid="ledger-loading"
      >
        Загрузка…
      </p>

      <!-- SPs not provisioned yet → point the admin at the setup card. -->
      <B24Alert
        v-else-if="loaded && !provisioned"
        color="air-primary"
        variant="soft"
        description="Смарт-процессы распределения ещё не настроены. Нажмите «Настроить смарт-процессы» выше."
        data-testid="ledger-unprovisioned"
      />

      <p
        v-else-if="loaded && cards.length === 0"
        class="text-sm italic text-(--ui-color-base-3)"
        data-testid="ledger-empty"
      >
        Распределённых платежей пока нет.
      </p>

      <div
        v-else-if="cards.length"
        class="flex flex-col gap-3"
        data-testid="ledger-cards"
      >
        <DistributionLedgerCard
          v-for="c in cards"
          :key="c.id"
          :card="c"
        />
      </div>
    </div>
  </B24Card>
</template>
