<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { AccordionItem } from '@bitrix24/b24ui-nuxt'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useChatSettings } from '~/composables/useChatSettings'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { isExcludedOperation, parseRuleLines, shouldNotifyChat } from '~/utils/statement'
import { B24_PAYMENT_TRIGGER } from '~/config/b24'
import type { OperationDirection } from '~/types/statement'

// Chat-notification settings form + live preview. One component for two entry points:
// the full page /settings and the dismissable slideover on /app (a slide-over panel —
// #219's "settings as a slider" spirit, without the B24 SDK slider, which only opens
// PORTAL paths not our own app page). Settings are grouped into a B24Accordion and
// persisted server-side (app.option via the frame token — see useChatSettings) with an
// EXPLICIT Save/Cancel (starter #219 pattern — no autosave). Gated on admin: a non-admin
// portal user sees a warning instead of the form. Content is withheld until the admin
// check resolves (no fail-open flash). When embedded in the slideover (`asSlider`),
// Save/Cancel emit `close` so /app can dismiss the panel; as a plain page they don't.
const props = defineProps<{ asSlider?: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
const cs = useChatSettings()
const { settings, enabled, saving, savedOk, loaded, error, notifyOption, errorOption, chatFetcher } = cs

// Gate state: `adminChecked` flips only after init resolves + checkAdmin runs, so
// the form is never rendered to an unverified (possibly non-admin) user.
const adminChecked = ref(false)
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
})

// Explicit Save (starter Save/Cancel pattern — no autosave). cs.save() persists AND
// notifies other open instances (pull `reload.options`). On success, close the slideover
// if embedded in one; keep the form open on error so the admin can retry.
async function saveAndClose(): Promise<void> {
  if (!enabled.value) return
  await cs.save()
  if (error.value) return
  if (props.asSlider) emit('close')
}

// Cancel = discard: re-fetch the server copy and re-seed the textarea editors, then (in the
// slideover) close. The re-fetch matters even for the slideover: it shares this SAME JS
// instance (the singleton settings), so without a reload the unsaved edits would still be in
// `settings` and reappear when the slideover is re-opened. Re-seeding the textareas is needed
// because they're seeded once on mount — a bare load() would leave them showing pre-cancel
// edits that then re-sync back into settings on the next keystroke.
async function cancel(): Promise<void> {
  if (enabled.value) {
    await cs.load()
    syncTextareas()
  }
  if (props.asSlider) emit('close')
}

// Accordion sections (starter B24Accordion pattern) — group the settings into
// collapsibles. v-model keys by item INDEX (b24ui default); '0' opens «Уведомления» first.
const openSections = ref(['0'])
const sections = computed(() => [
  { label: 'Уведомления в чат', slot: 'chats' },
  { label: 'Исключения', slot: 'exclusions' },
  { label: 'Авто-проведение оплат', slot: 'distribute' },
  { label: 'Карта распознавания', slot: 'recognition' }
] satisfies AccordionItem[])

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

      <B24Accordion
        v-model="openSections"
        type="multiple"
        :items="sections"
      >
        <!-- Уведомления в чат: чат уведомлений + направления + чат ошибок. -->
        <template #chats>
          <div class="space-y-4 pt-2">
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
          </div>
        </template>

        <!-- Исключения: полностью пропускаемые операции. -->
        <template #exclusions>
          <div class="space-y-4 pt-2">
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
        </template>

        <!-- Авто-проведение оплат: мутационный гейт §2. -->
        <template #distribute>
          <div class="space-y-4 pt-2">
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
        </template>

        <!-- Карта распознавания (#109 §4): matrices + alphabet + configFields. -->
        <template #recognition>
          <div class="pt-2">
            <RecognitionMap
              v-model="settings.recognition"
              :disabled="blocked"
            />
          </div>
        </template>
      </B24Accordion>

      <!-- Explicit Save/Cancel (no autosave). Save persists + notifies other instances. -->
      <div
        v-if="enabled"
        class="flex items-center gap-3"
      >
        <B24Button
          color="air-primary-success"
          :loading="saving"
          :disabled="saving || !isAdmin"
          :label="saving ? 'Сохранение…' : 'Сохранить'"
          data-testid="settings-save"
          @click="saveAndClose"
        />
        <B24Button
          color="air-tertiary"
          :disabled="saving"
          :label="asSlider ? 'Отмена' : 'Отменить изменения'"
          data-testid="settings-cancel"
          @click="cancel"
        />
        <span
          v-if="savedOk && !saving"
          class="text-sm text-(--ui-color-accent-main-success)"
          role="status"
          aria-live="polite"
          data-testid="save-status"
        >Сохранено ✓</span>
        <span
          v-else-if="error && !saving"
          class="text-sm text-(--ui-color-accent-main-alert)"
          role="status"
          aria-live="polite"
          data-testid="save-status"
        >{{ error }}</span>
      </div>
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
