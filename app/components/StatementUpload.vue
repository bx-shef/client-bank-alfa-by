<script setup lang="ts">
// Manual statement upload (P4, slice 1): drop one or more statement files, parse
// them IN THE BROWSER (deterministic — no backend/AI), and preview the operations.
// Reuses the tested parser (importUpload → manualImport) and the OperationList
// component. Writing the parsed batch to CRM is a later slice (file-parse queue).
import { computed, ref } from 'vue'
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_FILES,
  decodeUploadText,
  dedupItems,
  deferToEventLoop,
  processUploadBatch,
  type UploadItemResult
} from '~/utils/importUpload'
import { splitByDirection } from '~/utils/statement'
import { useImport } from '~/composables/useImport'

const results = ref<UploadItemResult[]>([])
// Raw files kept aligned 1:1 with `results` (same truncated batch order) so we can
// POST the ORIGINAL bytes — the server is the single parse authority (re-parses).
const batchFiles = ref<File[]>([])
const truncated = ref(0)
const dragOver = ref(false)
const busy = ref(false)
const submitting = ref(false)
const submitResult = ref<{ ok: boolean, message: string } | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
// Flips true after a successful «Записать в CRM» — the moment the user has clearly benefited, so the
// «оцените приложение» modal (AppRatingModal) can ask. The show decision is server-throttled; this
// only nudges the check. Inert outside a portal.
const ratingTrigger = ref(false)
// Decoded text + name of the first successfully-parsed file — offered (opt-in) to the feedback
// widget so an employee can attach the statement to a 👎 issue for reproduction (#198). Recomputed
// on each batch; empty when nothing parsed. Decode matches the parser (windows-1251).
const feedbackFileName = ref('')
const feedbackFileText = ref('')

// Combined, de-duped operations across all successfully parsed files.
const allItems = computed(() => dedupItems(results.value.flatMap(r => r.items)))
const okCount = computed(() => results.value.filter(r => r.ok).length)
const errCount = computed(() => results.value.filter(r => !r.ok).length)
const totals = computed(() => splitByDirection(allItems.value))
// Files that parsed OK (aligned with results) — those we send to CRM.
const okFiles = computed(() => batchFiles.value.filter((_, i) => results.value[i]?.ok))

const { submitFiles } = useImport()

async function processFiles(files: File[]) {
  if (!files.length) return
  busy.value = true
  submitResult.value = null
  // Pass RAW files so processUploadBatch computes `truncated` (files beyond the cap).
  // batchFiles slices to the same cap → stays index-aligned with out.results.
  const out = await processUploadBatch(files, deferToEventLoop)
  results.value = out.results
  batchFiles.value = files.slice(0, MAX_UPLOAD_FILES)
  truncated.value = out.truncated
  // Cache the first OK file's decoded text for the (opt-in) feedback attach (#198).
  const firstOk = batchFiles.value.find((_, i) => out.results[i]?.ok)
  if (firstOk) {
    feedbackFileName.value = firstOk.name
    try {
      feedbackFileText.value = decodeUploadText(await firstOk.arrayBuffer())
    } catch {
      feedbackFileText.value = '' // can't decode → just don't offer the attach
    }
  } else {
    feedbackFileName.value = ''
    feedbackFileText.value = ''
  }
  busy.value = false
}

async function writeToCrm() {
  submitting.value = true
  submitResult.value = await submitFiles(okFiles.value, allItems.value.length)
  submitting.value = false
  // A successful CRM write is the «benefited» moment → let the rating modal ask (server-throttled).
  if (submitResult.value?.ok) ratingTrigger.value = true
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  processFiles(Array.from(e.dataTransfer?.files ?? []))
}
function onInput(e: Event) {
  processFiles(Array.from((e.target as HTMLInputElement).files ?? []))
}
function clearAll() {
  results.value = []
  batchFiles.value = []
  truncated.value = 0
  submitResult.value = null
  feedbackFileName.value = ''
  feedbackFileText.value = ''
  if (fileInput.value) fileInput.value.value = ''
}
</script>

<template>
  <div class="space-y-6">
    <!-- Dropzone -->
    <div
      class="rounded-2xl border-2 border-dashed p-8 text-center transition-colors"
      :class="dragOver
        ? 'border-(--ui-color-accent-main-primary) bg-(--ui-color-design-tinted-na-bg)'
        : 'border-(--ui-color-base-4)'"
      data-testid="dropzone"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <p class="text-sm text-(--ui-color-base-3)">
        Перетащите сюда файл выписки ({{ ACCEPTED_EXTENSIONS.join(', ') }}) — формат
        <code class="rounded bg-(--ui-color-design-tinted-na-bg) px-1 py-0.5">1CClientBankExchange</code>
        или client-bank <code class="rounded bg-(--ui-color-design-tinted-na-bg) px-1 py-0.5">***** ^Type=</code>
      </p>
      <div class="mt-4 flex items-center justify-center gap-3">
        <B24Button
          label="Выбрать файлы"
          color="air-primary"
          :loading="busy"
          data-testid="pick"
          @click="fileInput?.click()"
        />
        <B24Button
          v-if="results.length"
          label="Очистить"
          color="air-secondary-no-accent"
          data-testid="clear"
          @click="clearAll()"
        />
      </div>
      <input
        ref="fileInput"
        type="file"
        :accept="ACCEPTED_EXTENSIONS.join(',')"
        multiple
        class="hidden"
        data-testid="file-input"
        @change="onInput"
      >
    </div>

    <!-- Too many files dropped at once -->
    <B24Alert
      v-if="truncated > 0"
      color="air-primary-warning"
      variant="soft"
      title="Взяты не все файлы"
      :description="`За один раз обрабатываем не больше ${MAX_UPLOAD_FILES} файлов. Остальные (${truncated}) пропущены — загрузите их отдельно.`"
      data-testid="truncated"
    />

    <!-- Results region — announced to screen readers as it fills in -->
    <div
      role="status"
      aria-live="polite"
      class="space-y-6"
    >
      <!-- Per-file results -->
      <ul
        v-if="results.length"
        class="space-y-2"
        data-testid="file-list"
      >
        <li
          v-for="(r, i) in results"
          :key="`${r.name}:${i}`"
          class="flex items-start justify-between gap-3 rounded-lg border border-(--ui-color-base-4) px-3 py-2 text-sm"
        >
          <span class="min-w-0 flex-1 break-words">
            {{ r.name }}
            <span
              v-if="!r.ok"
              class="block text-(--ui-color-accent-main-alert)"
            >{{ r.error }}</span>
          </span>
          <B24Badge
            v-if="r.ok"
            :label="`разобрано: ${r.items.length}`"
            color="air-primary-success"
            variant="soft"
            size="sm"
            class="mt-0.5 shrink-0"
          />
        </li>
      </ul>

      <!-- Summary + combined preview -->
      <template v-if="allItems.length">
        <p
          class="text-sm text-(--ui-color-base-3)"
          data-testid="summary"
        >
          Файлов: {{ okCount }}{{ errCount ? ` (ошибок: ${errCount})` : '' }} ·
          операций: {{ allItems.length }} ·
          приходов: {{ totals.credits.length }} · расходов: {{ totals.debits.length }}
        </p>

        <!-- Lively result summary (#62): count-up tiles + ECharts by-day / share charts. -->
        <ImportStatsChart :items="allItems" />

        <B24Card>
          <template #header>
            <h2 class="font-semibold">
              Предпросмотр операций
            </h2>
          </template>
          <OperationList :items="allItems" />
        </B24Card>

        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-3">
            <B24Button
              label="Записать в CRM"
              color="air-primary"
              :loading="submitting"
              data-testid="write-crm"
              @click="writeToCrm()"
            />
            <span class="text-xs text-(--ui-color-base-3)">
              Операции разобраны локально; по кнопке файл(ы) уходят в портал — запись идёт в фоне.
            </span>
          </div>
          <B24Alert
            v-if="submitResult"
            :color="submitResult.ok ? 'air-primary-success' : 'air-primary-alert'"
            variant="soft"
            :title="submitResult.ok ? 'Отправлено' : 'Не отправлено'"
            :description="submitResult.message"
            data-testid="submit-result"
          />
        </div>
      </template>

      <!-- All files failed -->
      <B24Alert
        v-else-if="results.length"
        color="air-primary-warning"
        variant="soft"
        title="Не удалось разобрать"
        description="Проверьте формат файла: ожидается 1CClientBankExchange или client-bank «***** ^Type=» в кодировке windows-1251."
        data-testid="all-failed"
      />
    </div>

    <!-- Feedback on the PARSE result (docs/FEEDBACK.md, channel «сотрудник»): 👍/👎 + optional
         comment; on 👎 the employee may opt in to attach the statement file to the private issue
         (#198). Renders only when the channel is enabled server-side and something parsed. -->
    <FeedbackWidget
      v-if="okCount"
      :file-name="feedbackFileName"
      :file-text="feedbackFileText"
      class="mt-4"
    />

    <!-- «Оцените приложение» — surfaces (server-throttled) after a successful CRM write; inert
         outside a portal. -->
    <AppRatingModal :trigger="ratingTrigger" />
  </div>
</template>
