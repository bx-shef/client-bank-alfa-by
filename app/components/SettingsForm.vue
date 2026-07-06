<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useChatSettings } from '~/composables/useChatSettings'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { parseRuleLines, shouldNotifyChat } from '~/utils/statement'
import type { OperationDirection } from '~/types/statement'

// Chat-notification settings form + live preview. One component for two entry
// points: the slideover on /app and the full page /settings. Persistence is
// server-side (app.option via the frame token — see useChatSettings). Gated on
// admin: a non-admin portal user sees a warning instead of the form.
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
const cs = useChatSettings()
const { settings, enabled, saving, loaded, error, notifyOption, errorOption, chatFetcher } = cs

// In the portal but NOT an admin ⇒ block the form (show a warning only).
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
// Re-fill the textareas from settings once they've loaded from the backend.
watch(loaded, ok => ok && syncTextareas())

onMounted(async () => {
  useB24().init() // idempotent; no-op outside the frame
  checkAdmin()
  if (!loaded.value) await cs.load()
  syncTextareas()
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

// Live preview: which mock operations would be announced to the notification chat.
const preview = computed(() =>
  MOCK_STATEMENT.items.map(item => ({ item, notify: shouldNotifyChat(item, settings.chat.rules) }))
)
const notifyCount = computed(() => preview.value.filter(r => r.notify).length)
</script>

<template>
  <!-- Non-admin in the portal: warning only, no settings. -->
  <B24Alert
    v-if="blocked"
    color="air-primary-warning"
    variant="soft"
    title="Настройки доступны только администратору"
    description="Обратитесь к администратору портала Bitrix24 — изменять параметры импорта и уведомлений может только он."
    data-testid="admin-gate"
  />

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
          <B24FormField
            label="Не уведомлять по счетам"
            description="По одному номеру счёта в строке."
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
            label="Не уведомлять по теме платежа"
            description="Подстроки, по одной в строке. Напр.: между своими счетами."
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

      <div class="flex items-center gap-3">
        <B24Button
          label="Сохранить"
          color="air-primary"
          :loading="saving"
          :disabled="!enabled || saving"
          data-testid="save"
          @click="cs.save()"
        />
        <span
          v-if="error"
          class="text-xs text-(--ui-color-accent-main-alert)"
          data-testid="save-error"
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
        data-testid="preview-summary"
      >
        В чат попадёт {{ notifyCount }} из {{ preview.length }} операций
      </p>

      <B24Alert
        v-if="notifyCount === 0"
        color="air-primary-warning"
        variant="soft"
        description="При текущих правилах в чат ничего не попадёт."
      />

      <ul
        v-else
        data-testid="preview-list"
        class="space-y-2"
      >
        <li
          v-for="row in preview"
          :key="row.item.docId"
          class="flex items-center justify-between gap-3 text-sm"
        >
          <span class="truncate">{{ row.item.counterparty.name }}</span>
          <B24Badge
            :label="row.notify ? '→ в чат' : 'скрыто'"
            :color="row.notify ? 'air-primary-success' : 'air-secondary'"
            variant="soft"
            size="sm"
            class="shrink-0"
          />
        </li>
      </ul>
    </B24Card>
  </div>
</template>
