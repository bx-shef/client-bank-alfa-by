<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useFeedback } from '~/composables/useFeedback'

// Compact 👍/👎 feedback widget under an import result. Renders nothing unless the channel is enabled
// on the server (probed via useFeedback → GITHUB_FEEDBACK_* configured). 👍 sends immediately; 👎
// first opens a comment box («что пошло не так»), then sends. Inert outside a portal (submit no-ops).
// Optional fileName traces the issue back to a run (rendered inert server-side; the receiving repo is
// private, so client context is permitted). See docs/FEEDBACK.md.
// `fileText` (the decoded statement text) enables the file-attach consent (#198): when present, the
// 👎 box offers a checkbox to attach the raw statement to the private issue for reproduction.
const props = defineProps<{ fileName?: string, fileText?: string }>()
const { enabled, ensureEnabled, submit } = useFeedback()

const open = ref(false) // comment box shown
const comment = ref('')
const attachFile = ref(false) // consent to attach the statement file (default OFF — explicit opt-in)
const sending = ref(false)
const sent = ref(false)
const error = ref('')

onMounted(() => {
  ensureEnabled()
})

// A new file (re-parse without unmounting the widget) must NOT inherit consent/comment given for the
// previous file — otherwise a 👎 could attach the WRONG statement under stale consent. Reset the
// interaction state whenever the underlying statement text changes.
watch(() => props.fileText, () => {
  attachFile.value = false
  open.value = false
  comment.value = ''
  sent.value = false
  error.value = ''
})

async function rate(kind: 'up' | 'down'): Promise<void> {
  // 👎 → ask what went wrong before sending (a comment makes negative feedback actionable). 👍 stays
  // an instant, no-friction positive signal.
  if (kind === 'down' && !open.value) {
    open.value = true
    error.value = '' // don't carry a stale 👍-submit error into the freshly-opened comment box
    return
  }
  sending.value = true
  error.value = ''
  try {
    // submit() returns false (without throwing) outside a portal frame — do NOT claim success.
    // Attach the statement ONLY on a 👎 (the consent box lives in the 👎 panel), when ticked AND we
    // have the text — so an instant 👍 never carries a file even if the box was opened and ticked.
    const fileContent = kind === 'down' && attachFile.value && props.fileText ? props.fileText : undefined
    const ok = await submit(kind, comment.value.trim() || undefined, { fileName: props.fileName, fileContent })
    if (ok) sent.value = true
    else error.value = 'Отзыв доступен только внутри портала Bitrix24'
  } catch {
    error.value = 'Не удалось отправить отзыв'
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div
    v-if="enabled"
    class="mt-1 text-xs"
    data-testid="feedback-widget"
  >
    <p
      v-if="sent"
      class="text-(--ui-color-accent-main-success)"
      role="status"
      data-testid="feedback-sent"
    >
      Спасибо за отзыв!
    </p>
    <template v-else>
      <div class="flex items-center gap-2 text-(--ui-color-base-4)">
        <span>Результат помог?</span>
        <button
          type="button"
          class="rounded px-1.5 py-0.5 hover:bg-(--ui-color-base-5) disabled:opacity-50"
          :disabled="sending"
          aria-label="Хорошо"
          data-testid="feedback-up"
          @click="rate('up')"
        >
          👍
        </button>
        <button
          type="button"
          class="rounded px-1.5 py-0.5 hover:bg-(--ui-color-base-5) disabled:opacity-50"
          :disabled="sending"
          aria-label="Плохо"
          data-testid="feedback-down"
          @click="rate('down')"
        >
          👎
        </button>
      </div>
      <!-- Ошибка отправки (в т.ч. для 👍-пути, где нет поля комментария). -->
      <p
        v-if="error && !open"
        class="mt-1 text-(--ui-color-accent-main-alert)"
        role="alert"
      >
        {{ error }}
      </p>
      <div
        v-if="open"
        class="mt-1 flex flex-col gap-1"
      >
        <textarea
          v-model="comment"
          rows="2"
          maxlength="5000"
          aria-label="Что пошло не так"
          placeholder="Что пошло не так? (необязательно)"
          data-testid="feedback-comment"
          class="w-full rounded border border-(--ui-color-base-5) p-1.5 text-xs"
        />
        <!-- Consent to attach the raw statement file (#198). Shown only when a file is available
             (fileText). Default OFF — the statement holds client financial data, so attaching it
             is an explicit opt-in; it goes to a PRIVATE issue and helps reproduce a parse bug. -->
        <B24Checkbox
          v-if="fileText"
          v-model="attachFile"
          size="sm"
          label="Приложить файл выписки к отзыву (поможет разобраться; данные видны только нам)"
          data-testid="feedback-attach"
        />
        <div class="flex items-center gap-2">
          <B24Button
            size="xs"
            color="air-primary"
            :loading="sending"
            :disabled="sending"
            :label="sending ? 'Отправка…' : 'Отправить'"
            @click="rate('down')"
          />
          <span
            v-if="error"
            class="text-(--ui-color-accent-main-alert)"
            role="alert"
          >{{ error }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
