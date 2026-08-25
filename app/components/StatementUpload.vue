<script setup lang="ts">
// Manual statement upload (P4, slice 1): drop one or more statement files, parse
// them IN THE BROWSER (deterministic — no backend/AI), and preview the operations.
// Reuses the tested parser (importUpload → manualImport) and the OperationList
// component. Writing the parsed batch to CRM is a later slice (file-parse queue).
import { computed, onMounted, ref } from 'vue'
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
import { MAX_FILE_EMBED } from '~/utils/feedback'
import { useImport, type ImportOutcome } from '~/composables/useImport'
import { useImportBatches } from '~/composables/useImportBatches'
import { useLocalMode } from '~/composables/useLocalMode'
import { batchStateLabel, summaryMessage } from '~/utils/importBatchView'

// Локальный режим форка (#39): скрывает попап «оцените приложение» (наш листинг Маркета).
const localMode = useLocalMode()

const results = ref<UploadItemResult[]>([])
// Raw files kept aligned 1:1 with `results` (same truncated batch order) so we can
// POST the ORIGINAL bytes — the server is the single parse authority (re-parses).
const batchFiles = ref<File[]>([])
const truncated = ref(0)
const dragOver = ref(false)
const busy = ref(false)
const submitting = ref(false)
const submitResult = ref<ImportOutcome | null>(null)
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
// Monotonic token so a superseded batch's async decode can't clobber a newer batch's state.
let procSeq = 0

// Combined, de-duped operations across all successfully parsed files.
const allItems = computed(() => dedupItems(results.value.flatMap(r => r.items)))
const okCount = computed(() => results.value.filter(r => r.ok).length)
const errCount = computed(() => results.value.filter(r => !r.ok).length)
const totals = computed(() => splitByDirection(allItems.value))
// Files that parsed OK (aligned with results) — those we send to CRM.
const okFiles = computed(() => batchFiles.value.filter((_, i) => results.value[i]?.ok))

const { submitFiles } = useImport()
// Итог обработки КОНКРЕТНОЙ загрузки (#417): раньше страница отвечала «принято» и замолкала,
// хотя запись в CRM идёт в фоне и её исход сотруднику как раз и нужен.
const batches = useImportBatches()
const batchSummary = computed(() => summaryMessage(batches.results.value))
// Перезагрузка вкладки не должна стирать исход: обработка идёт в фоне, ключи лежат в
// sessionStorage, поэтому вернувшийся сотрудник видит результат, а не «принято» из ниоткуда.
onMounted(() => {
  void batches.restore()
})

async function processFiles(files: File[]) {
  if (!files.length) return
  const seq = ++procSeq
  busy.value = true
  submitResult.value = null
  // Pass RAW files so processUploadBatch computes `truncated` (files beyond the cap).
  // batchFiles slices to the same cap → stays index-aligned with out.results.
  const out = await processUploadBatch(files, deferToEventLoop)
  if (seq !== procSeq) return // a newer drop superseded this batch — don't clobber its state
  results.value = out.results
  batchFiles.value = files.slice(0, MAX_UPLOAD_FILES)
  truncated.value = out.truncated
  // Cache the first OK file's decoded text for the (opt-in) feedback attach (#198). Cap to
  // MAX_FILE_EMBED so only what could ever be embedded travels over the wire (not the full ≤2 МБ).
  const firstOk = batchFiles.value.find((_, i) => out.results[i]?.ok)
  if (firstOk) {
    feedbackFileName.value = firstOk.name
    try {
      const text = decodeUploadText(await firstOk.arrayBuffer())
      if (seq !== procSeq) return // superseded during the async decode
      feedbackFileText.value = text.slice(0, MAX_FILE_EMBED)
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
  batches.reset()
  submitResult.value = await submitFiles(okFiles.value, allItems.value.length)
  submitting.value = false
  // Ключи есть и у частичного отказа (часть файлов приняли) — их итог всё равно доедет.
  if (submitResult.value.batchIds.length) void batches.track(submitResult.value.batchIds)
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
      title="Взяты не все файлы"
      :description="`За один раз обрабатываем не больше ${MAX_UPLOAD_FILES} файлов. Остальные (${truncated}) пропущены — загрузите их отдельно.`"
      data-testid="truncated"
    />

    <!-- Results block. NOT a live region itself (U3, #430): wrapping the whole block in
         role=status made SR re-announce the entire file list + preview on every change and
         nested the alerts inside a live region. Only the one-line summary below is live. -->
    <div class="space-y-6">
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
            size="sm"
            class="mt-0.5 shrink-0"
          />
        </li>
      </ul>

      <!-- Summary + combined preview. The summary line is the ONE live region here — a short,
           stable sentence a screen reader can announce without flooding (U3). -->
      <template v-if="allItems.length">
        <p
          role="status"
          aria-live="polite"
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
        title="Не удалось разобрать"
        description="Проверьте формат файла: ожидается 1CClientBankExchange или client-bank «***** ^Type=» в кодировке windows-1251."
        data-testid="all-failed"
      />
      <!-- Реальный исход обработки (#417). НЕ под гейтом предпросмотра: после перезагрузки вкладки
           предпросмотра нет (он живёт только в памяти), а итог как раз и нужен — иначе восстановление
           ключей из sessionStorage опрашивало бы сервер в невидимую разметку. -->
      <B24Card
        v-if="batches.results.value.length || batches.polling.value || batches.timedOut.value"
        data-testid="batch-results"
      >
        <template #header>
          <h2 class="font-semibold">
            Результат обработки
          </h2>
        </template>

        <ul class="space-y-2 text-sm">
          <li
            v-for="r in batches.results.value"
            :key="r.batchId"
            class="flex flex-wrap items-center justify-between gap-2"
          >
            <span class="min-w-0 flex-1 break-words">{{ r.fileName || 'файл без имени' }}</span>
            <!-- Состояние несёт БЕЙДЖ, а не только цвет текста: иначе «ошибка» и «записано» в ч/б
                 и для дальтоника неотличимы. -->
            <B24Badge
              :label="batchStateLabel(r)"
              :color="r.state === 'error' ? 'air-primary-alert' : r.state === 'queued' ? 'air-secondary-accent' : 'air-primary-success'"
              size="sm"
            />
          </li>
        </ul>

        <p
          v-if="batchSummary"
          class="mt-3 text-sm text-(--ui-color-base-3)"
        >
          {{ batchSummary }}
        </p>
        <p
          v-else-if="batches.polling.value"
          class="mt-3 text-sm text-(--ui-color-base-3)"
        >
          Обрабатываем загрузку…
        </p>

        <!-- Опрос сдался по времени. Молча замереть здесь нельзя — это ровно тот молчащий импорт,
             который #417 и чинит, только на три минуты позже. -->
        <template v-if="batches.timedOut.value">
          <B24Alert
            color="air-primary-warning"
            title="Обработка занимает дольше обычного"
            description="Запись в CRM продолжается в фоне — страницу можно закрыть, результат появится в делах компании. Или проверьте ещё раз."
            class="mt-3"
          />
          <B24Button
            label="Проверить ещё раз"
            color="air-secondary-no-accent"
            size="sm"
            class="mt-3"
            @click="batches.retry()"
          />
        </template>

        <!-- Отзыв стоит здесь, у ИТОГА, а не только под разбором (#499): «разобралось» и
             «записалось» — разные события, и жалуются обычно на второе. Файл к отзыву прикладывается
             по галке в 👎-панели, как и ниже.
             ⚠ Только когда итог УЖЕ есть: карточка показывается и во время опроса, и спрашивать
             «результат помог?» рядом со строкой «обрабатываем загрузку…» — это вопрос о том, чего
             человек ещё не видел. -->
        <FeedbackWidget
          v-if="!batches.polling.value"
          :file-name="feedbackFileName"
          :file-text="feedbackFileText"
          place="загрузка"
          class="mt-4"
        />
      </B24Card>
    </div>

    <!-- Feedback on the PARSE result (docs/FEEDBACK.md, channel «сотрудник»): 👍/👎 + optional
         comment; on 👎 the employee may opt in to attach the statement file to the private issue
         (#198). Renders only when the channel is enabled server-side and something parsed. -->
    <FeedbackWidget
      v-if="okCount"
      :file-name="feedbackFileName"
      :file-text="feedbackFileText"
      place="разбор"
      class="mt-4"
    />

    <!-- «Оцените приложение» — surfaces (server-throttled) after a successful CRM write; inert
         outside a portal. В локальном режиме форка (#39) скрыт: попап про НАШ листинг Маркета. -->
    <AppRatingModal
      v-if="!localMode"
      :trigger="ratingTrigger"
    />
  </div>
</template>
