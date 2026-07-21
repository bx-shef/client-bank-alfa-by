<script setup lang="ts">
// «Карта сопоставления» — UI editor for payment-purpose recognition (#109, PROCESSING.md §4).
// Binds to the shared reactive `RecognitionSettings` (matrices + alphabet + configFields) via
// v-model; the parent SettingsForm persists on explicit Save. Replaces hand-editing the
// `app.option` JSON. Uses b24ui (B24Card/B24Select/B24Input/B24Button/B24FormField/B24Badge).
// The server still defensively coerces/clamps everything (parsePortalSettings, DoS caps) — this
// form is convenience, not the source of trust.
import { computed, ref } from 'vue'
import type { Alphabet, IdentifierKind, RecognizedId } from '~/utils/purposeMatch'
import { recognizeByMatrices } from '~/utils/purposeMatch'
import type { RecognitionSettings } from '~/utils/settings'
import { ALPHABET_ITEMS, CONFIG_FIELD_ROWS, IDENTIFIER_KIND_ITEMS, IDENTIFIER_KIND_LABELS, blankMatrix } from '~/utils/recognitionKinds'

const recognition = defineModel<RecognitionSettings>({ required: true })
defineProps<{ disabled?: boolean }>()

// Stable per-row key for the matrix v-for: keyed by the matrix OBJECT identity (a WeakMap),
// not the array index — so deleting a row doesn't reuse the input instance of the row below
// (index keys glitch focus/IME on a splice-able editable list). No stored-data pollution: the
// id lives only in this client map, never in the persisted matrix. `Math.random` is avoided
// (SSR-hydration-safe) — a plain monotone counter.
let keySeq = 0
const rowKeys = new WeakMap<object, number>()
function rowKey(m: object): number {
  const existing = rowKeys.get(m)
  if (existing !== undefined) return existing
  const k = keySeq++
  rowKeys.set(m, k)
  return k
}

function addMatrix() {
  recognition.value.matrices.push(blankMatrix())
}
function removeMatrix(index: number) {
  recognition.value.matrices.splice(index, 1)
}

/** configFields get/set with delete-on-blank (an empty value must NOT persist a blank key —
 *  the resolver treats a missing key as "not configured", a blank string is noise). */
function configField(key: string): string {
  return recognition.value.configFields[key] ?? ''
}
function setConfigField(key: string, value: string) {
  const v = value.trim()
  // Rebuild without the key rather than `delete` (dynamic-delete is lint-blocked, and a
  // reassign cleanly triggers reactivity + the parent's deep-watch autosave). Blank ⇒ key
  // absent (the resolver reads a missing key as "not configured"; a blank string is noise).
  const next: Record<string, string> = {}
  for (const [k, val] of Object.entries(recognition.value.configFields)) {
    if (k !== key) next[k] = val
  }
  if (v) next[key] = v
  recognition.value.configFields = next
}

// Live preview — run the REAL recognizer over a test purpose so the admin sees what their
// matrices actually extract (kind + value). Pure, client-side, no I/O.
const previewText = ref('')
const previewIds = computed<RecognizedId[]>(() =>
  previewText.value.trim()
    ? recognizeByMatrices(previewText.value, recognition.value.matrices, recognition.value.alphabet)
    : []
)
</script>

<template>
  <B24Card data-testid="recognition-map">
    <template #header>
      <h2 class="font-semibold">
        Карта сопоставления (распознавание платежей)
      </h2>
    </template>

    <p class="mb-4 text-sm text-(--ui-color-base-3)">
      Как из назначения платежа извлечь номер счёта/заказа и понять, к какой сущности CRM его отнести.
      Маска: <code class="font-mono">d</code> — цифра, остальные символы — как есть
      (напр. <code class="font-mono">СЧ-dddd</code>, <code class="font-mono">BOPC-ddd/dd</code>).
    </p>

    <B24FormField
      label="Алфавит распознавания"
      class="mb-4"
    >
      <template #description>
        Кир/лат гомоглифы (<code class="font-mono">ВОРС</code>↔<code class="font-mono">BOPC</code>) сводятся к выбранному алфавиту.
      </template>
      <B24Select
        :model-value="recognition.alphabet"
        :items="ALPHABET_ITEMS"
        :disabled="disabled"
        size="sm"
        class="w-56"
        aria-label="Алфавит распознавания"
        data-testid="recognition-alphabet"
        @update:model-value="v => (recognition.alphabet = v as Alphabet)"
      />
    </B24FormField>

    <!-- Matrices: one row = mask → kind (+ optional note). -->
    <div class="mb-2 text-sm font-medium">
      Матрицы ({{ recognition.matrices.length }})
    </div>
    <p
      v-if="recognition.matrices.length === 0"
      class="mb-3 text-sm text-(--ui-color-base-3)"
      data-testid="recognition-empty"
    >
      Матриц нет — распознавание не сработает. Добавьте хотя бы одну.
    </p>
    <ul class="mb-3 space-y-2">
      <li
        v-for="(m, i) in recognition.matrices"
        :key="rowKey(m)"
        class="flex flex-wrap items-start gap-2"
        data-testid="matrix-row"
      >
        <B24Input
          :model-value="m.mask"
          placeholder="СЧ-dddd"
          :disabled="disabled"
          size="sm"
          class="w-40 font-mono"
          aria-label="Маска"
          @update:model-value="v => (m.mask = String(v))"
        />
        <B24Select
          :model-value="m.kind"
          :items="IDENTIFIER_KIND_ITEMS"
          :disabled="disabled"
          size="sm"
          class="w-72"
          aria-label="Вид сущности"
          @update:model-value="v => (m.kind = v as IdentifierKind)"
        />
        <B24Input
          :model-value="m.note ?? ''"
          placeholder="комментарий (необязательно)"
          :disabled="disabled"
          size="sm"
          class="w-48"
          aria-label="Комментарий"
          @update:model-value="v => (m.note = String(v).trim() || undefined)"
        />
        <B24Button
          color="air-tertiary-no-accent"
          size="sm"
          :disabled="disabled"
          aria-label="Удалить матрицу"
          data-testid="matrix-remove"
          @click="removeMatrix(i)"
        >
          Удалить
        </B24Button>
      </li>
    </ul>
    <B24Button
      color="air-secondary-accent-1"
      size="sm"
      :disabled="disabled"
      data-testid="matrix-add"
      @click="addMatrix"
    >
      + Добавить матрицу
    </B24Button>

    <!-- Config-field map: portal-specific field names / SP entityTypeId. -->
    <div class="mt-5 mb-2 text-sm font-medium">
      Настроенные поля
    </div>
    <div class="space-y-3">
      <B24FormField
        v-for="row in CONFIG_FIELD_ROWS"
        :key="row.key"
        :label="row.label"
      >
        <template #description>
          {{ row.hint }}
        </template>
        <B24Input
          :model-value="configField(row.key)"
          :disabled="disabled"
          size="sm"
          class="w-72 font-mono text-xs"
          :aria-label="row.label"
          :data-testid="`config-field-${row.key}`"
          @update:model-value="v => setConfigField(row.key, String(v))"
        />
      </B24FormField>
    </div>

    <!-- Live preview: run the real recognizer over a test purpose. -->
    <div class="mt-5">
      <B24FormField label="Проверить на назначении">
        <B24Input
          v-model="previewText"
          placeholder="Оплата по счёту СЧ-1042 за услуги"
          size="sm"
          class="w-full"
          aria-label="Тестовое назначение"
          data-testid="recognition-preview-input"
        />
      </B24FormField>
      <div
        class="mt-2 flex flex-wrap items-center gap-2 text-sm"
        aria-live="polite"
        data-testid="recognition-preview-out"
      >
        <template v-if="previewText.trim() && previewIds.length === 0">
          <span class="text-(--ui-color-base-3)">Ничего не распознано.</span>
        </template>
        <B24Badge
          v-for="(r, i) in previewIds"
          :key="i"
          color="air-primary-success"
          size="sm"
        >
          {{ IDENTIFIER_KIND_LABELS[r.kind] }}: {{ r.value }}
        </B24Badge>
      </div>
    </div>
  </B24Card>
</template>
