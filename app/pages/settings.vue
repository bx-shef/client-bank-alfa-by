<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useChatRules } from '~/composables/useChatRules'
import { MOCK_CHATS } from '~/config/chat'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { parseRuleLines, shouldNotifyChat } from '~/utils/statement'
import type { OperationDirection } from '~/types/statement'
import { useB24 } from '~/composables/useB24'
import { pageTitle } from '~/utils/landing'

// In-portal page: `clear` layout wraps it in <B24App> for iframe theming.
definePageMeta({ layout: 'clear' })

// Document title for standalone; in the portal parent.setTitle sets the iframe chrome.
useHead({ title: pageTitle('Настройки') })

// Demo, client-side persistence. Wires the chat-notify filter (pure logic in
// utils/statement.ts) with a live preview. Real key/chat storage moves
// server-side with the backend (app.option, #16).
const { settings, rules } = useChatRules()

const b24 = useB24()
onMounted(async () => {
  await b24.init()
  if (!b24.isInit()) return
  try {
    const $b24 = b24.getOrThrow()
    await $b24.parent.setTitle('Настройки')
    await $b24.parent.fitWindow()
  } catch (e) {
    if (import.meta.dev) console.warn('[settings] B24 parent calls failed', e)
  }
})

// Chat options for B24Select ({ label, value }). No empty-string item — B24Select
// reserves '' for the placeholder/cleared state (it throws on an empty value).
const chatItems = computed(() => MOCK_CHATS.map(c => ({ label: c.title, value: c.id })))

// Direction toggles as switches (get/set over the directions array).
function directionModel(d: OperationDirection) {
  return computed<boolean>({
    get: () => settings.value.directions.includes(d),
    set: (on) => {
      const set = new Set(settings.value.directions)
      if (on) set.add(d)
      else set.delete(d)
      settings.value.directions = [...set]
    }
  })
}
const notifyCredit = directionModel('credit')
const notifyDebit = directionModel('debit')

// Textareas edit line-lists; mirror to settings via parseRuleLines (one-way).
const accountsText = ref('')
const patternsText = ref('')
onMounted(() => {
  accountsText.value = settings.value.excludeAccounts.join('\n')
  patternsText.value = settings.value.excludePurposePatterns.join('\n')
})
watch(accountsText, v => (settings.value.excludeAccounts = parseRuleLines(v)))
watch(patternsText, v => (settings.value.excludePurposePatterns = parseRuleLines(v)))

// Live preview: which mock operations would be announced to the chat.
const preview = computed(() =>
  MOCK_STATEMENT.items.map(item => ({ item, notify: shouldNotifyChat(item, rules.value) }))
)
const notifyCount = computed(() => preview.value.filter(r => r.notify).length)
</script>

<template>
  <main class="mx-auto max-w-5xl px-4 py-6">
    <h1 class="text-2xl font-semibold">
      Настройки
    </h1>

    <B24Alert
      color="air-primary-warning"
      variant="soft"
      title="Демо-режим"
      description="Настройки хранятся локально в браузере, ключ API не сохраняется. Реальное хранение — на сервере."
      class="mt-3"
    />

    <ClientOnly>
      <div class="mt-6 grid gap-6 lg:grid-cols-[1fr_320px] lg:items-start">
        <!-- Form: three grouped sections. -->
        <B24Form
          :state="settings"
          class="space-y-6"
        >
          <B24Card>
            <template #header>
              <h2 class="font-semibold">
                Подключение банка
              </h2>
            </template>
            <B24FormField
              label="Ключ API клиент-банка"
              description="По вашей компании. Не сохраняется — вводится на сессию."
            >
              <B24Input
                v-model="settings.apiKey"
                type="password"
                autocomplete="off"
                placeholder="Введите ключ API"
                class="w-full"
                data-testid="api-key"
              />
            </B24FormField>
          </B24Card>

          <B24Card>
            <template #header>
              <h2 class="font-semibold">
                Уведомления в чат
              </h2>
            </template>
            <div class="space-y-4">
              <B24FormField label="Чат для уведомлений">
                <B24Select
                  v-model="settings.chatId"
                  :items="chatItems"
                  placeholder="Выберите чат"
                  class="w-full"
                  data-testid="chat-select"
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

          <p class="text-xs text-(--ui-color-base-3)">
            Настройки сохраняются автоматически.
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
    </ClientOnly>
  </main>
</template>
