<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useChatSettings } from '~/composables/useChatSettings'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { isExcludedOperation, parseRuleLines, shouldNotifyChat } from '~/utils/statement'
import { B24_PAYMENT_TRIGGER } from '~/config/b24'
import type { OperationDirection } from '~/types/statement'

// Chat-notification settings form + live preview. One component for two entry
// points: the slideover on /app and the full page /settings. Persistence is
// server-side (app.option via the frame token — see useChatSettings), autosaved on
// change. Gated on admin: a non-admin portal user sees a warning instead of the
// form. Content is withheld until the admin check resolves (no fail-open flash).
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
const cs = useChatSettings()
const { settings, enabled, saving, savedOk, loaded, error, notifyOption, errorOption, chatFetcher } = cs

// Gate state: `adminChecked` flips only after init resolves + checkAdmin runs, so
// the form is never rendered to an unverified (possibly non-admin) user.
const adminChecked = ref(false)
const autosaveReady = ref(false)
const blocked = computed(() => inPortal.value && !isAdmin.value)

// Exclusion textareas edit line-lists; mirror to settings via parseRuleLines.
const accountsText = ref('')
const patternsText = ref('')
function syncTextareas() {
  accountsText.value = (settings.chat.rules.excludeAccounts ?? []).join('\n')
  patternsText.value = (settings.chat.rules.excludePurposePatterns ?? []).join('\n')
}
watch(accountsText, v => (settings.chat.rules.excludeAccounts = parseRuleLines(v)))
watch(patternsText, v => (settings.chat.rules.excludePurposePatterns = parseRuleLines(v)))

onMounted(async () => {
  // Await init AND a tick: useB24 flips its ready flag on nextTick after the frame
  // handshake, so isInit() lags an un-awaited init(). Without this the gate reads
  // "not in portal" and fails open (form shown to a non-admin) on a cold load.
  await useB24().init()
  await nextTick()
  checkAdmin()
  adminChecked.value = true
  if (blocked.value) return // non-admin: don't load or expose the form
  if (!loaded.value) await cs.load()
  syncTextareas()
  autosaveReady.value = true // enable autosave only AFTER load populates settings
})

// Autosave (debounced) to the backend on any change — no explicit Save, no lost
// edits when the slideover is dismissed. Guarded so the load-time populate and the
// standalone (no-portal) preview don't trigger writes.
watchDebounced(settings, () => {
  if (autosaveReady.value && enabled.value) cs.save()
}, { debounce: 800, deep: true })

// Flush a final save on teardown (e.g. slideover dismissed inside the debounce
// window) so the last edit isn't lost. Idempotent write; no-op without frame auth.
onBeforeUnmount(() => {
  if (autosaveReady.value && enabled.value) cs.save()
})

// Direction toggles as switches (get/set over the notify rules array).
function directionModel(d: OperationDirection) {
  return computed<boolean>({
    get: () => (settings.chat.rules.directions ?? []).includes(d),
    set: (on) => {
      const set = new Set(settings.chat.rules.directions ?? [])
      if (on) set.add(d)
      else set.delete(d)
      settings.chat.rules.directions = [...set]
    }
  })
}
const notifyCredit = directionModel('credit')
const notifyDebit = directionModel('debit')

// Paid-invoice stage (§2): a plain string model over the optional nested field. get
// returns '' when unset; set trims and clears the key on blank so the saved blob stays
// minimal (matches `cleanAllocation` on the backend — blank ⇒ no stage change).
const invoicePaidStageModel = computed<string>({
  get: () => settings.allocation.invoicePaidStageId ?? '',
  set: (v) => {
    const s = v.trim()
    if (s) settings.allocation.invoicePaidStageId = s
    else delete settings.allocation.invoicePaidStageId
  }
})

// Automation-trigger CODE (#79): the app registers a canonical trigger at install
// (`B24_PAYMENT_TRIGGER`); to arm firing the admin attaches it to an automation rule
// and puts its CODE here. Same plain-string-over-optional-field pattern as the stage;
// blank ⇒ key removed ⇒ the worker's `autoDistribute && triggerCode` gate stays off.
const triggerCodeModel = computed<string>({
  get: () => settings.allocation.triggerCode ?? '',
  set: (v) => {
    const s = v.trim()
    if (s) settings.allocation.triggerCode = s
    else delete settings.allocation.triggerCode
  }
})
// Surfaced in the help text so the admin knows exactly what to register/attach.
const paymentTrigger = B24_PAYMENT_TRIGGER

// Live preview: for each mock operation, whether it's announced to the chat AND whether it's
// EXCLUDED from import entirely (PROCESSING §2 A2). Excluded ops are a different outcome from
// direction-silenced ones (excluded = not in CRM at all; silenced = in CRM, just not announced),
// so the preview labels them distinctly instead of a single «скрыто».
const preview = computed(() =>
  MOCK_STATEMENT.items.map(item => ({
    item,
    excluded: isExcludedOperation(item, settings.chat.rules),
    notify: shouldNotifyChat(item, settings.chat.rules)
  }))
)
const notifyCount = computed(() => preview.value.filter(r => r.notify).length)
const excludedCount = computed(() => preview.value.filter(r => r.excluded).length)
const previewSummary = computed(() => {
  const base = `В чат попадёт ${notifyCount.value} из ${preview.value.length} операций`
  return excludedCount.value > 0 ? `${base}, ${excludedCount.value} — не импортируется` : base
})
</script>

<template>
  <!-- Withhold everything until the admin check resolves (no fail-open flash). -->
  <p
    v-if="!adminChecked"
    class="text-sm text-(--ui-color-base-3)"
    data-testid="checking"
  >
    Проверка доступа…
  </p>

  <!-- Non-admin in the portal: warning only, no settings. -->
  <B24Alert
    v-else-if="blocked"
    color="air-primary-warning"
    variant="soft"
    title="Настройки доступны только администратору"
    description="Обратитесь к администратору портала Bitrix24 — изменять параметры импорта и уведомлений может только он."
    data-testid="admin-gate"
  />

  <!-- In portal, settings still loading. -->
  <p
    v-else-if="enabled && !loaded"
    class="text-sm text-(--ui-color-base-3)"
    data-testid="loading"
  >
    Загрузка настроек…
  </p>

  <div
    v-else
    class="grid gap-6 lg:grid-cols-[1fr_320px] lg:items-start"
  >
    <B24Form
      :state="settings"
      class="space-y-6"
    >
      <B24Alert
        v-if="!enabled"
        color="air-primary"
        variant="soft"
        description="Настройки сохраняются внутри портала Bitrix24. Здесь — предпросмотр."
        class="mb-2"
      />

      <B24Card>
        <template #header>
          <h2 class="font-semibold">
            Уведомления в чат
          </h2>
        </template>
        <div class="space-y-4">
          <B24FormField
            label="Чат для уведомлений"
            description="Куда слать сообщения о новых операциях."
          >
            <AsyncSearchSelect
              v-model="settings.chat.dialogId"
              :fetcher="chatFetcher"
              :selected-option="notifyOption"
              placeholder="Начните вводить название чата"
              data-testid="notify-chat"
              @update:selected-option="o => (settings.chat.title = o?.label as string | undefined)"
            />
          </B24FormField>

          <B24Switch
            v-model="notifyCredit"
            label="Приходы"
            description="когда деньги пришли на счёт"
            data-testid="notify-credit"
          />
          <B24Switch
            v-model="notifyDebit"
            label="Расходы"
            description="списания со счёта"
            data-testid="notify-debit"
          />
        </div>
      </B24Card>

      <B24Card>
        <template #header>
          <h2 class="font-semibold">
            Чат для ошибок
          </h2>
        </template>
        <B24FormField
          label="Чат ошибок импорта"
          description="Сюда приложение пишет о сбоях обработки — деловым тоном, с пометкой, что рапортует «Импорт выписки из клиент-банка». Отдельно от чата уведомлений."
        >
          <AsyncSearchSelect
            v-model="settings.errorChat.dialogId"
            :fetcher="chatFetcher"
            :selected-option="errorOption"
            placeholder="Начните вводить название чата"
            data-testid="error-chat"
            @update:selected-option="o => (settings.errorChat.title = o?.label as string | undefined)"
          />
        </B24FormField>
      </B24Card>

      <B24Card>
        <template #header>
          <h2 class="font-semibold">
            Исключения
          </h2>
        </template>
        <div class="space-y-4">
          <p class="text-sm text-(--ui-color-base-3)">
            Такие операции <strong>полностью пропускаются</strong>: не создаётся дело в CRM и не уходит
            уведомление в чат. (Чтобы просто не слать в чат, но заносить в CRM — используйте
            переключатели «Приходы/Расходы» выше.)
          </p>
          <B24FormField
            label="Не загружать по счетам"
            description="По одному номеру счёта в строке. Операции по этим счетам не попадут в CRM."
          >
            <B24Textarea
              v-model="accountsText"
              :rows="3"
              autoresize
              placeholder="BY00..."
              class="w-full font-mono text-xs"
              data-testid="exclude-accounts"
            />
          </B24FormField>
          <B24FormField
            label="Не загружать по теме платежа"
            description="Подстроки, по одной в строке. Совпало — операция не попадёт в CRM. Напр.: между своими счетами."
          >
            <B24Textarea
              v-model="patternsText"
              :rows="3"
              autoresize
              placeholder="между своими счетами"
              class="w-full text-xs"
              data-testid="exclude-patterns"
            />
          </B24FormField>
        </div>
      </B24Card>

      <B24Card>
        <template #header>
          <h2 class="font-semibold">
            Авто-проведение оплат
          </h2>
        </template>
        <div class="space-y-4">
          <B24Switch
            v-model="settings.autoDistribute"
            label="Автоматически отмечать оплату в CRM"
            description="Когда платёж однозначно распознан по номеру — приложение само пометит оплату «оплачено» / переведёт счёт на оплаченную стадию, а для сделки/смарт-процесса запустит триггер автоматизации (если задан код ниже)."
            data-testid="auto-distribute"
          />
          <B24Alert
            v-if="settings.autoDistribute"
            color="air-primary-warning"
            variant="soft"
            title="Приложение будет изменять данные в CRM"
            description="При включённой опции приложение само проводит однозначно распознанные оплаты. Если не уверены — оставьте выключенным: тогда приложение только фиксирует, к чему относится платёж, ничего не меняя в портале."
            data-testid="auto-distribute-warning"
          />
          <B24FormField
            v-if="settings.autoDistribute"
            label="Стадия оплаченного счёта"
            description="Идентификатор стадии, в которую перевести смарт-счёт при оплате (напр. DT31_11:P). Оставьте пустым — стадию счёта менять не будем."
          >
            <B24Input
              v-model="invoicePaidStageModel"
              placeholder="DT31_11:P"
              class="w-full font-mono text-xs"
              data-testid="invoice-paid-stage"
            />
          </B24FormField>
          <B24FormField
            v-if="settings.autoDistribute"
            label="Код триггера автоматизации"
            data-testid="trigger-code-field"
          >
            <template #description>
              При установке приложение зарегистрировало триггер
              <strong>«{{ paymentTrigger.name }}»</strong>. Повесьте его на своё правило автоматизации
              (сделки/смарт-процесса), затем впишите код <code class="font-mono">{{ paymentTrigger.code }}</code>
              сюда — тогда при разнесении платежа на сделку приложение запустит этот триггер.
              Оставьте пустым — триггер запускаться не будет.
            </template>
            <B24Input
              v-model="triggerCodeModel"
              :placeholder="paymentTrigger.code"
              class="w-full font-mono text-xs"
              data-testid="trigger-code"
            />
          </B24FormField>
        </div>
      </B24Card>

      <!-- Recognition «карта сопоставления» (#109 §4): matrices + alphabet + configFields. -->
      <RecognitionMap
        v-model="settings.recognition"
        :disabled="blocked"
      />

      <!-- Autosave status (no explicit Save button). Announced to screen readers. -->
      <p
        v-if="enabled"
        class="text-xs"
        :class="error ? 'text-(--ui-color-accent-main-alert)' : 'text-(--ui-color-base-3)'"
        role="status"
        aria-live="polite"
        data-testid="save-status"
      >
        <template v-if="saving">
          Сохранение…
        </template>
        <template v-else-if="error">
          {{ error }}
        </template>
        <template v-else-if="savedOk">
          Сохранено ✓
        </template>
        <template v-else>
          Изменения сохраняются автоматически.
        </template>
      </p>
    </B24Form>

    <!-- Live preview: the main feedback of the settings. -->
    <B24Card class="lg:sticky lg:top-4">
      <template #header>
        <h2 class="font-semibold">
          Что попадёт в чат
        </h2>
      </template>

      <p
        class="mb-3 text-sm text-(--ui-color-base-3)"
        aria-live="polite"
        data-testid="preview-summary"
      >
        {{ previewSummary }}
      </p>

      <B24Alert
        v-if="notifyCount === 0"
        color="air-primary-warning"
        variant="soft"
        description="При текущих правилах в чат ничего не попадёт."
      />

      <ul
        data-testid="preview-list"
        class="space-y-2"
      >
        <li
          v-for="row in preview"
          :key="row.item.docId"
          class="flex items-center justify-between gap-3 text-sm"
        >
          <span class="truncate">{{ row.item.counterparty.name }}</span>
          <!-- Three distinct outcomes: excluded (not imported at all) vs silenced-in-chat
               (imported, not announced) vs announced. -->
          <B24Badge
            :label="row.excluded ? 'не импортируется' : row.notify ? '→ в чат' : 'скрыто в чате'"
            :color="row.excluded ? 'air-primary-alert' : row.notify ? 'air-primary-success' : 'air-secondary'"
            variant="soft"
            size="sm"
            class="shrink-0"
          />
        </li>
      </ul>
    </B24Card>
  </div>
</template>
