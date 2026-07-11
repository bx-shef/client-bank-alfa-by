<script setup lang="ts">
// Public landing DEMO: attach a statement file and instantly see WHAT the app
// extracts — operations, counterparties, totals, and identifiers recognized in the
// payment purpose. Parsing is done in the browser (deterministic, no backend/AI);
// the pure core lives in app/utils/demoExtract.ts. Styling is self-contained dark
// (landing brand shell) so it does not depend on b24ui light/dark tokens. (The
// online Alfa/Prior "sandbox" buttons were retired in favour of info cards in
// index.vue — live bank OAuth is geo-blocked from the cloud anyway.)
import { computed, ref } from 'vue'
import ArrowTopSIcon from '@bitrix24/b24icons-vue/outline/ArrowTopSIcon'
import ArrowDownSIcon from '@bitrix24/b24icons-vue/outline/ArrowDownSIcon'
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_FILES,
  dedupItems,
  deferToEventLoop,
  processUploadBatch
} from '~/utils/importUpload'
import { summarizeExtraction, type DemoExtraction } from '~/utils/demoExtract'
import { formatMoney } from '~/utils/activity'
import { LANDING_DEMO, LANDING_DEMO_SAMPLES, type DemoSample } from '~/utils/landing'
import type { IdentifierKind } from '~/utils/purposeMatch'

const { reachGoal } = useMetrikaGoal()

const samples = LANDING_DEMO_SAMPLES

/** Cap rendered rows (operations AND recognized-id rows) so a crafted multi-MB
 *  upload can't freeze the tab by mounting tens of thousands of nodes; the overflow
 *  is summarized as a count. */
const MAX_RENDERED_OPS = 100
/** Cap identifier badges per recognized row (one crafted purpose could match a
 *  matrix hundreds of times); the rest are summarized as "+N". */
const MAX_RECOGNIZED_IDS_PER_ROW = 12

const extraction = ref<DemoExtraction | null>(null)
const sourceLabel = ref('')
const busy = ref(false)
const error = ref('')
const fileErrors = ref<string[]>([])
const truncated = ref(0)
const dragOver = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// Monotonic action token: every source action bumps it. A file parse (the only
// async source) discards its result if a newer action superseded it while it was
// in flight — so a slow parse can't clobber a bank-demo the user picked afterwards.
let runSeq = 0

const visibleOps = computed(() => extraction.value?.items.slice(0, MAX_RENDERED_OPS) ?? [])
const hiddenOpsCount = computed(() =>
  Math.max(0, (extraction.value?.items.length ?? 0) - MAX_RENDERED_OPS)
)
const visibleRecognized = computed(() => extraction.value?.recognized.slice(0, MAX_RENDERED_OPS) ?? [])
const hiddenRecognizedCount = computed(() =>
  Math.max(0, (extraction.value?.recognized.length ?? 0) - MAX_RENDERED_OPS)
)

// Human labels for the recognized identifier kinds (§4). Demo set only needs a few.
const KIND_LABEL: Record<IdentifierKind, string> = {
  'invoice-number': 'Смарт-счёт',
  'invoice-id': 'Смарт-счёт (id)',
  'deal-id': 'Сделка (id)',
  'deal-field': 'Сделка (поле)',
  'order-id': 'Заказ (id)',
  'order-number': 'Заказ',
  'payment-id': 'Оплата (id)',
  'payment-number': 'Оплата',
  'smart-id': 'Смарт-процесс (id)',
  'smart-field': 'Смарт-процесс (поле)',
  'document-number': 'Документ'
}

/** Tax-id label by currency: RUB → ИНН (Russian), otherwise УНП (Belarusian).
 *  The `counterparty.unp` field is a generic tax id; only its label differs. */
function taxIdLabel(currency: string): string {
  return currency === 'RUB' ? 'ИНН' : 'УНП'
}

/** Reset transient state shared by all sources (keeps `busy` handling to callers). */
function clearFeedback() {
  error.value = ''
  fileErrors.value = []
  truncated.value = 0
}

async function runFiles(files: File[]) {
  if (!files.length) return
  const seq = ++runSeq
  busy.value = true
  clearFeedback()
  try {
    const out = await processUploadBatch(files, deferToEventLoop)
    if (seq !== runSeq) return // superseded by a newer source action — discard
    const okItems = dedupItems(out.results.flatMap(r => r.items))
    fileErrors.value = out.results.filter(r => !r.ok).map(r => `${r.name}: ${r.error}`)
    truncated.value = out.truncated
    const okCount = out.results.filter(r => r.ok).length
    if (!okItems.length) {
      extraction.value = null
      error.value = fileErrors.value.length ? LANDING_DEMO.parseError : LANDING_DEMO.noOperations
    } else {
      extraction.value = summarizeExtraction(okItems)
      sourceLabel.value = files.length === 1
        ? (files[0]?.name ?? 'загруженный файл')
        : `загружено файлов: ${okCount}`
      reachGoal('demo_file') // count only successful extractions
    }
  } finally {
    if (seq === runSeq) busy.value = false
  }
}

/** One-click "try a sample": fetch a bundled example statement and run it through
 *  the same file path. The user can also just download it (link) and drop it in. */
async function loadSample(sample: DemoSample) {
  if (busy.value) return
  const seq = ++runSeq // claim this action so reset()/another source can supersede the fetch
  busy.value = true
  clearFeedback()
  try {
    const res = await fetch(sample.url)
    if (!res.ok) throw new Error('fetch failed')
    const buf = await res.arrayBuffer()
    if (seq !== runSeq) return // superseded during the fetch (e.g. reset) — discard
    reachGoal('demo_sample')
    // runFiles owns the runSeq/busy/results lifecycle from here.
    await runFiles([new File([buf], sample.name, { type: 'text/plain' })])
  } catch {
    if (seq !== runSeq) return // superseded — a newer action owns busy/state now
    error.value = 'Не удалось загрузить пример. Скачайте файл по ссылке и загрузите вручную.'
    busy.value = false
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false
  if (busy.value) return
  runFiles(Array.from(e.dataTransfer?.files ?? []))
}
function onInput(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  // Clear the value so re-selecting the SAME file fires `change` again.
  input.value = ''
  runFiles(files)
}
function reset() {
  runSeq++ // cancel any in-flight parse
  busy.value = false
  extraction.value = null
  clearFeedback()
  if (fileInput.value) fileInput.value.value = ''
}
</script>

<template>
  <div class="rounded-3xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
    <div class="flex flex-col gap-5">
      <!-- Dropzone -->
      <div
        class="rounded-2xl border-2 border-dashed p-7 text-center transition-colors"
        :class="dragOver ? 'border-[rgb(var(--color-accent-primary-ch))] bg-[rgb(var(--color-accent-primary-ch)/0.06)]' : 'border-white/15'"
        data-testid="demo-dropzone"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
      >
        <p class="text-sm text-white/70">
          Перетащите сюда файл выписки ({{ ACCEPTED_EXTENSIONS.join(', ') }}) — или
        </p>
        <div class="mt-4 flex items-center justify-center gap-3">
          <B24Button
            :label="busy ? 'Разбираем…' : 'Выбрать файл'"
            color="air-primary"
            :loading="busy"
            data-testid="demo-pick"
            @click="fileInput?.click()"
          />
          <B24Button
            v-if="extraction || error"
            label="Сбросить"
            color="air-secondary-no-accent"
            data-testid="demo-reset"
            @click="reset()"
          />
        </div>
        <input
          ref="fileInput"
          type="file"
          :accept="ACCEPTED_EXTENSIONS.join(',')"
          multiple
          class="hidden"
          data-testid="demo-file-input"
          @change="onInput"
        >
        <p class="mt-3 text-xs text-white/40">
          {{ LANDING_DEMO.hint }} Максимум {{ MAX_UPLOAD_FILES }} файлов за раз.
        </p>
      </div>

      <!-- Sample statements: load in one click, or download and drop in yourself. -->
      <div
        class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2 text-sm"
        data-testid="demo-samples"
      >
        <span class="text-white/55">Нет своей выписки? Попробуйте на примере:</span>
        <template
          v-for="s in samples"
          :key="s.url"
        >
          <span class="inline-flex items-center gap-1.5">
            <B24Button
              :label="s.label"
              color="air-secondary-no-accent"
              size="sm"
              :disabled="busy"
              data-testid="demo-sample"
              @click="loadSample(s)"
            />
            <a
              :href="s.url"
              :download="s.name"
              class="text-xs text-white/45 underline underline-offset-2 hover:text-white/70"
              @click="reachGoal('demo_sample_download')"
            >скачать</a>
          </span>
        </template>
      </div>

      <!-- Privacy warning: think about what you upload to a public demo. -->
      <div
        class="flex items-start gap-2 rounded-xl border border-[rgb(var(--color-accent-alert-ch)/0.3)] bg-[rgb(var(--color-accent-alert-ch)/0.06)] px-4 py-3 text-xs text-white/70"
        data-testid="demo-privacy"
      >
        <span aria-hidden="true">⚠️</span>
        <span>{{ LANDING_DEMO.privacyWarning }}</span>
      </div>
    </div>

    <!-- Live region: results / errors -->
    <div
      role="status"
      aria-live="polite"
      :aria-busy="busy"
      class="mt-6 space-y-5"
    >
      <!-- Parse error -->
      <div
        v-if="error"
        class="rounded-xl border border-[rgb(var(--color-accent-alert-ch)/0.4)] bg-[rgb(var(--color-accent-alert-ch)/0.08)] px-4 py-3 text-sm text-white/85"
        data-testid="demo-error"
      >
        {{ error }}
      </div>

      <!-- Too many files dropped at once -->
      <div
        v-if="truncated > 0"
        class="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-white/60"
        data-testid="demo-truncated"
      >
        Взяли не все файлы: за один раз обрабатываем не больше {{ MAX_UPLOAD_FILES }}. Пропущено: {{ truncated }}.
      </div>

      <!-- Per-file warnings (some files failed but others parsed) -->
      <div
        v-if="fileErrors.length && extraction"
        class="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-white/60"
        data-testid="demo-file-warn"
      >
        <div class="mb-1 font-medium text-white/75">
          Пропущены файлы:
        </div>
        <div
          v-for="(fe, i) in fileErrors"
          :key="i"
          class="break-words"
        >
          {{ fe }}
        </div>
      </div>

      <template v-if="extraction">
        <!-- Summary -->
        <div data-testid="demo-summary">
          <div class="mb-3 flex flex-wrap items-baseline gap-x-2 text-sm text-white/60">
            <span>Извлекли из:</span>
            <span class="font-mono text-white/85 break-words">{{ sourceLabel }}</span>
          </div>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div class="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div class="text-2xl font-bold text-white">
                {{ extraction.operationCount }}
              </div>
              <div class="text-xs text-white/50">
                операций
              </div>
            </div>
            <div class="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div class="text-2xl font-bold text-[rgb(var(--color-accent-success-ch))]">
                {{ extraction.creditCount }}
              </div>
              <div class="text-xs text-white/50">
                приходов
              </div>
            </div>
            <div class="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div class="text-2xl font-bold text-white">
                {{ extraction.debitCount }}
              </div>
              <div class="text-xs text-white/50">
                расходов
              </div>
            </div>
            <div class="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div class="text-2xl font-bold text-white">
                {{ extraction.counterpartyCount }}
              </div>
              <div class="text-xs text-white/50">
                контрагентов
              </div>
            </div>
          </div>

          <!-- Per-currency totals -->
          <div class="mt-3 flex flex-wrap gap-2">
            <span
              v-for="t in extraction.totals"
              :key="t.currency"
              class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-white/70"
            >
              <span class="font-mono">{{ t.currency }}</span>
              <span class="ml-2 text-[rgb(var(--color-accent-success-ch))]">+{{ formatMoney(t.credit) }}</span>
              <span class="ml-2 text-white/60">−{{ formatMoney(t.debit) }}</span>
            </span>
          </div>
        </div>

        <!-- Recognized identifiers -->
        <div
          v-if="extraction.recognized.length"
          class="rounded-2xl border border-[rgb(var(--color-accent-primary-ch)/0.25)] bg-[rgb(var(--color-accent-primary-ch)/0.05)] p-4"
          data-testid="demo-recognized"
        >
          <div class="mb-3 text-sm font-semibold text-white">
            Распознали в назначении платежа
          </div>
          <ul class="space-y-2">
            <li
              v-for="(r, i) in visibleRecognized"
              :key="`${r.docId}:${i}`"
              class="text-sm text-white/70"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span
                  v-for="(id, j) in r.ids.slice(0, MAX_RECOGNIZED_IDS_PER_ROW)"
                  :key="j"
                  class="rounded-md bg-[rgb(var(--color-accent-primary-ch)/0.18)] px-2 py-0.5 font-mono text-xs text-white"
                >{{ KIND_LABEL[id.kind] }}: {{ id.value }}</span>
                <span
                  v-if="r.ids.length > MAX_RECOGNIZED_IDS_PER_ROW"
                  class="text-white/45"
                >+{{ r.ids.length - MAX_RECOGNIZED_IDS_PER_ROW }}</span>
                <span class="text-white/45">← {{ r.counterparty }}</span>
              </div>
            </li>
          </ul>
          <p
            v-if="hiddenRecognizedCount > 0"
            class="mt-2 text-xs text-white/40"
            data-testid="demo-recognized-overflow"
          >
            …и ещё {{ hiddenRecognizedCount }} распознанных
          </p>
        </div>

        <!-- Operations -->
        <div class="space-y-2">
          <div class="text-sm font-semibold text-white">
            Операции
          </div>
          <ul class="space-y-2">
            <li
              v-for="(op, i) in visibleOps"
              :key="`${op.account}:${op.docId}:${i}`"
              class="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3"
              data-testid="demo-operation"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <component
                      :is="op.direction === 'credit' ? ArrowTopSIcon : ArrowDownSIcon"
                      class="size-4 shrink-0"
                      :class="op.direction === 'credit' ? 'text-[rgb(var(--color-accent-success-ch))]' : 'text-white/50'"
                    />
                    <span class="truncate font-medium text-white">
                      {{ op.counterparty.name || op.counterparty.account || 'Контрагент не указан' }}
                    </span>
                  </div>
                  <div
                    v-if="op.counterparty.unp || op.counterparty.account"
                    class="mt-0.5 font-mono text-xs text-white/40 break-all"
                  >
                    <span v-if="op.counterparty.unp">{{ taxIdLabel(op.currency) }} {{ op.counterparty.unp }}</span>
                    <span v-if="op.counterparty.unp && op.counterparty.account"> · </span>
                    <span v-if="op.counterparty.account">{{ op.counterparty.account }}</span>
                  </div>
                </div>
                <div
                  class="shrink-0 text-right font-mono text-sm"
                  :class="op.direction === 'credit' ? 'text-[rgb(var(--color-accent-success-ch))]' : 'text-white/80'"
                >
                  {{ op.direction === 'credit' ? '+' : '−' }}{{ formatMoney(op.amount) }} {{ op.currency }}
                </div>
              </div>
              <p
                v-if="op.purpose"
                class="mt-2 text-xs text-white/55 leading-relaxed break-words"
              >
                {{ op.purpose }}
              </p>
            </li>
          </ul>
          <p
            v-if="hiddenOpsCount > 0"
            class="text-xs text-white/40"
            data-testid="demo-ops-overflow"
          >
            …и ещё {{ hiddenOpsCount }} операций
          </p>
        </div>
      </template>
    </div>
  </div>
</template>
