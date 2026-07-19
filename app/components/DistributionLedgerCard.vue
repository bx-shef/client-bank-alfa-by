<script setup lang="ts">
import { computed } from 'vue'
import type { LedgerCard } from '~/composables/useDistributionLedger'
import { presentPaymentLedger } from '~/utils/distributionView'

// One payment carrier card for the «Распределение» tab (#109 §9.3 #4). Presentational only — the
// view-model comes from the shared pure `presentPaymentLedger` (money math = distributionSummary).
const props = defineProps<{ card: LedgerCard }>()

const view = computed(() => presentPaymentLedger(props.card.total, props.card.currency, props.card.rows))
</script>

<template>
  <B24Card data-testid="ledger-card">
    <div class="space-y-3">
      <!-- Header: total + remaining, with status badges. -->
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div class="text-sm text-(--ui-color-base-3)">
            Платёж #{{ card.id }}
          </div>
          <div class="font-semibold">
            {{ view.totalText }}
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <B24Badge
            :label="`осталось ${view.remainingText}`"
            :color="view.remaining > 0 ? 'air-primary-warning' : 'air-primary-success'"
            variant="soft"
            size="sm"
            data-testid="ledger-remaining"
          />
          <B24Badge
            v-if="view.overLimit"
            label="перераспределено"
            color="air-primary-alert"
            variant="soft"
            size="sm"
            data-testid="ledger-overlimit"
          />
          <B24Badge
            v-if="card.requiresRedistribution"
            label="требует распределения"
            color="air-primary-alert"
            variant="soft"
            size="sm"
            data-testid="ledger-requires"
          />
        </div>
      </div>

      <!-- Distribution rows. -->
      <ul
        v-if="view.rows.length"
        class="m-0 flex list-none flex-col gap-1 p-0"
      >
        <li
          v-for="(r, i) in view.rows"
          :key="i"
          class="flex items-center justify-between gap-2 text-sm"
          :class="{ 'opacity-50 line-through': !r.active }"
        >
          <span class="text-(--ui-color-base-2)">{{ r.label }}</span>
          <span class="flex items-center gap-2">
            <span>{{ r.amountText }}</span>
            <B24Badge
              :label="r.source === 'manual' ? 'вручную' : 'авто'"
              color="air-secondary"
              variant="soft"
              size="xs"
            />
          </span>
        </li>
      </ul>
      <p
        v-else
        class="text-sm italic text-(--ui-color-base-3)"
      >
        Распределений пока нет.
      </p>
    </div>
  </B24Card>
</template>
