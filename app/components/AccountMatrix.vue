<script setup lang="ts">
import { computed } from 'vue'
import { MATRIX_STATE_LABEL, matrixIsClean, type MatrixRow } from '~/utils/bankAccountMatrix'
import type { MatrixProviderStatus } from '~/composables/useBankMatrix'
import { BANK_LABELS } from '~/utils/bankLabels'

// «Наш счёт ↔ счёт в банке» (#494) — the screen that answers «почему платежи не приземляются».
//
// The first live run produced «117 обработано, 0 создано» with a perfectly healthy transport: the
// account number typed at connect time did not match the requisite in CRM. Nothing anywhere said
// so. This block puts both sides next to each other, so a mismatch is visible before the first
// statement arrives instead of being inferred from a counter afterwards.
//
// ⚠ WHY WORKING ROWS ARE COLLAPSED, NOT HIDDEN. A screen that lists everything buries the one line
// that matters; a screen that shows only problems makes the admin doubt it ran at all. So problems
// render as full rows with an instruction, and matches collapse into one quiet line of counting.
//
// PRESENTATIONAL ON PURPOSE: the data comes from the parent card, which shares ONE `/api/bank/matrix`
// call with the connected-accounts list above (that list turns the bank side into pickable chips).
// Fetching here as well would ask the bank twice per render and could show the two blocks
// disagreeing with each other.

const props = defineProps<{
  rows: MatrixRow[]
  providers: MatrixProviderStatus[]
  loading: boolean
  loaded: boolean
  error: string
}>()

const clean = computed(() => matrixIsClean(props.rows))
const problems = computed(() => props.rows.filter(r => r.state !== 'matched'))
const providerErrors = computed(() => props.providers.filter(p => p.error))

function providerLabel(id: string): string {
  return BANK_LABELS[id as keyof typeof BANK_LABELS] ?? id
}

/** Colour follows severity, not decoration: `bank-only` money lands nowhere, `looks-same` looks
 *  correct and is not, `crm-only` is often perfectly fine (another bank, not connected yet). */
function stateColor(state: MatrixRow['state']) {
  if (state === 'bank-only') return 'air-primary-alert' as const
  if (state === 'looks-same') return 'air-primary-warning' as const
  return 'air-secondary-accent' as const
}
</script>

<template>
  <section
    class="space-y-3"
    data-testid="account-matrix"
  >
    <h3 class="text-sm font-semibold">
      Сверка счетов: CRM ↔ банк
    </h3>

    <p
      v-if="loading && !loaded"
      class="text-sm text-(--ui-color-base-3)"
      role="status"
      aria-live="polite"
    >
      Сверяем…
    </p>

    <div
      role="alert"
      aria-live="assertive"
    >
      <B24Alert
        v-if="error"
        color="air-primary-alert"
        :description="error"
        data-testid="matrix-error"
      />
    </div>

    <!-- Отказ конкретного банка показываем ОТДЕЛЬНО от строк: пустой ответ из-за сбоя нельзя
         рисовать как «банк не отдаёт ни одного счёта» — админ пойдёт править исправные реквизиты. -->
    <B24Alert
      v-for="p in providerErrors"
      :key="p.provider"
      color="air-primary-warning"
      :description="`${providerLabel(p.provider)}: ${p.error}. Список счетов этого банка сейчас неизвестен — строки ниже показывают только сторону CRM.`"
      :data-testid="`matrix-provider-error-${p.provider}`"
    />

    <p
      v-if="loaded && !rows.length && !error"
      class="text-sm text-(--ui-color-base-3)"
      data-testid="matrix-empty"
    >
      Сверять пока нечего: в реквизитах «моих компаний» нет расчётных счетов, и ни один банк не
      сообщил о своих. Добавьте счёт в реквизиты своей компании и подключите банк.
    </p>

    <p
      v-else-if="loaded && clean && rows.length"
      class="text-sm text-(--ui-color-accent-main-success)"
      data-testid="matrix-clean"
    >
      Всё сходится: {{ rows.length }} — счета в реквизитах совпадают с тем, что отдаёт банк.
    </p>

    <ul
      v-if="problems.length"
      class="space-y-2"
      data-testid="matrix-problems"
    >
      <li
        v-for="(r, i) in problems"
        :key="`${r.state}-${r.crm?.number ?? ''}-${r.bank?.number ?? ''}-${i}`"
        class="rounded-md border border-(--ui-color-design-tinted-na-stroke) p-3"
        :data-testid="`matrix-row-${r.state}`"
      >
        <div class="flex flex-wrap items-center gap-2">
          <B24Badge
            :color="stateColor(r.state)"
            size="xs"
            :label="MATRIX_STATE_LABEL[r.state].title"
          />
          <B24Badge
            v-if="r.connected"
            color="air-secondary-accent"
            size="xs"
            label="подключён"
          />
        </div>

        <dl class="mt-2 grid gap-1 text-xs sm:grid-cols-2">
          <div>
            <dt class="text-(--ui-color-base-3)">
              В реквизитах CRM
            </dt>
            <dd class="truncate font-mono">
              {{ r.crm?.number || '—' }}
            </dd>
          </div>
          <div>
            <dt class="text-(--ui-color-base-3)">
              Отдаёт банк
            </dt>
            <dd class="truncate font-mono">
              {{ r.bank?.number || '—' }}
            </dd>
          </div>
        </dl>

        <p class="mt-2 text-xs text-(--ui-color-base-3)">
          {{ MATRIX_STATE_LABEL[r.state].hint }}
        </p>
      </li>
    </ul>

    <p
      v-if="loaded && problems.length && rows.length > problems.length"
      class="text-xs text-(--ui-color-base-3)"
      data-testid="matrix-matched-count"
    >
      Остальные {{ rows.length - problems.length }} — сходятся.
    </p>
  </section>
</template>
