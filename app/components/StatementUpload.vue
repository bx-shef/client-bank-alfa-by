<script setup lang="ts">
// Manual statement upload (P4, slice 1): drop one or more statement files, parse
// them IN THE BROWSER (deterministic — no backend/AI), and preview the operations.
// Reuses the tested parser (importUpload → manualImport) and the OperationList
// component. Writing the parsed batch to CRM is a later slice (file-parse queue).
import { computed, ref } from 'vue'
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_FILES,
  decodeAndParse,
  dedupItems,
  uploadErrorMessage,
  validateUploadFile,
  type UploadItemResult
} from '~/utils/importUpload'
import { splitByDirection } from '~/utils/statement'

const results = ref<UploadItemResult[]>([])
const dragOver = ref(false)
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// Combined, de-duped operations across all successfully parsed files.
const allItems = computed(() => dedupItems(results.value.flatMap(r => r.items)))
const okCount = computed(() => results.value.filter(r => r.ok).length)
const errCount = computed(() => results.value.filter(r => !r.ok).length)
const totals = computed(() => splitByDirection(allItems.value))

async function processFiles(files: File[]) {
  if (!files.length) return
  busy.value = true
  const batch = files.slice(0, MAX_UPLOAD_FILES)
  const out: UploadItemResult[] = []
  for (const file of batch) {
    const invalid = validateUploadFile(file.name, file.size)
    if (invalid) {
      out.push({ name: file.name, ok: false, items: [], error: invalid })
      continue
    }
    try {
      const items = decodeAndParse(await file.arrayBuffer())
      out.push({ name: file.name, ok: true, items })
    } catch (e) {
      out.push({ name: file.name, ok: false, items: [], error: uploadErrorMessage(e) })
    }
  }
  results.value = out
  busy.value = false
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

    <!-- Per-file results -->
    <ul
      v-if="results.length"
      class="space-y-2"
      data-testid="file-list"
    >
      <li
        v-for="r in results"
        :key="r.name"
        class="flex items-center justify-between gap-3 rounded-lg border border-(--ui-color-base-4) px-3 py-2 text-sm"
      >
        <span class="truncate">{{ r.name }}</span>
        <B24Badge
          :label="r.ok ? `разобрано: ${r.items.length}` : r.error"
          :color="r.ok ? 'air-primary-success' : 'air-primary-alert'"
          variant="soft"
          size="sm"
          class="shrink-0"
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

      <B24Card>
        <template #header>
          <h2 class="font-semibold">
            Предпросмотр операций
          </h2>
        </template>
        <OperationList :items="allItems" />
      </B24Card>

      <B24Alert
        color="air-primary"
        variant="soft"
        title="Это предпросмотр"
        description="Операции разобраны локально в браузере. Запись в CRM (поиск компании, дела, дедуп) — следующим шагом."
      />
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
</template>
