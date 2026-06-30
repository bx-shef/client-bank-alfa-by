<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useChatRules } from '~/composables/useChatRules'
import { MOCK_CHATS } from '~/config/chat'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { parseRuleLines, shouldNotifyChat } from '~/utils/statement'
import type { OperationDirection } from '~/types/statement'
import { useB24 } from '~/composables/useB24'

// In-portal page: `clear` layout wraps it in <B24App> for iframe theming.
definePageMeta({ layout: 'clear' })

// In-portal settings (demo, client-side persistence). Wires the chat-notify
// filter (pure logic in utils/statement.ts) with a live preview. Real API-key /
// chat storage moves server-side with the backend/SDK.
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

// Textareas edit line-lists; mirror to settings via parseRuleLines (one-way:
// textarea → settings, no reverse watcher, so no feedback loop). useChatRules()
// loads localStorage synchronously in setup (before this onMounted), so the
// textareas seed from the already-loaded settings.
const accountsText = ref('')
const patternsText = ref('')
onMounted(() => {
  accountsText.value = settings.value.excludeAccounts.join('\n')
  patternsText.value = settings.value.excludePurposePatterns.join('\n')
})
watch(accountsText, v => (settings.value.excludeAccounts = parseRuleLines(v)))
watch(patternsText, v => (settings.value.excludePurposePatterns = parseRuleLines(v)))

const directions: { value: OperationDirection, label: string }[] = [
  { value: 'credit', label: 'Приходы' },
  { value: 'debit', label: 'Расходы' }
]
const hasDirection = (d: OperationDirection) => settings.value.directions.includes(d)
function toggleDirection(d: OperationDirection) {
  const set = new Set(settings.value.directions)
  if (set.has(d)) set.delete(d)
  else set.add(d)
  settings.value.directions = [...set]
}

// Live preview: which mock operations would be announced to the chat.
const preview = computed(() =>
  MOCK_STATEMENT.items.map(item => ({ item, notify: shouldNotifyChat(item, rules.value) }))
)
</script>

<template>
  <main class="mx-auto max-w-3xl px-4 py-8">
    <h1 class="text-2xl font-semibold">
      Настройки
    </h1>
    <p class="mt-1 text-sm text-(--b24ui-color-text-secondary)">
      Демо: настройки фильтра/чата хранятся локально в браузере. Ключ API не сохраняется (вводится
      на сессию); реальные ключ и чат подключаются на сервере.
    </p>

    <ClientOnly>
      <div class="mt-6 space-y-6">
        <label class="block">
          <span class="text-sm font-medium">Ключ API клиент-банка (по «моей компании»)</span>
          <input
            v-model="settings.apiKey"
            type="password"
            autocomplete="off"
            aria-label="Ключ API клиент-банка"
            placeholder="введите ключ API (не сохраняется)"
            class="mt-1 w-full rounded-lg border border-(--b24ui-color-design-tinted-na-stroke) bg-transparent px-3 py-2 text-sm"
          >
        </label>

        <label class="block">
          <span class="text-sm font-medium">Чат для уведомлений</span>
          <select
            v-model="settings.chatId"
            aria-label="Чат для уведомлений"
            class="mt-1 w-full rounded-lg border border-(--b24ui-color-design-tinted-na-stroke) bg-transparent px-3 py-2 text-sm"
          >
            <option value="">
              — не выбран —
            </option>
            <option
              v-for="chat in MOCK_CHATS"
              :key="chat.id"
              :value="chat.id"
            >
              {{ chat.title }}
            </option>
          </select>
        </label>

        <fieldset>
          <legend class="text-sm font-medium">
            Что отправлять в чат
          </legend>
          <div class="mt-2 flex gap-4">
            <label
              v-for="d in directions"
              :key="d.value"
              class="flex items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                :checked="hasDirection(d.value)"
                @change="toggleDirection(d.value)"
              >
              {{ d.label }}
            </label>
          </div>
        </fieldset>

        <label class="block">
          <span class="text-sm font-medium">Не показывать по р/счёту (по одному в строке)</span>
          <textarea
            v-model="accountsText"
            rows="3"
            aria-label="Не показывать по р/счёту"
            placeholder="BY00..."
            class="mt-1 w-full rounded-lg border border-(--b24ui-color-design-tinted-na-stroke) bg-transparent px-3 py-2 font-mono text-xs"
          />
        </label>

        <label class="block">
          <span class="text-sm font-medium">Не показывать по теме платежа (подстроки, по одной в строке)</span>
          <textarea
            v-model="patternsText"
            rows="3"
            aria-label="Не показывать по теме платежа"
            placeholder="между своими счетами"
            class="mt-1 w-full rounded-lg border border-(--b24ui-color-design-tinted-na-stroke) bg-transparent px-3 py-2 text-xs"
          />
        </label>
      </div>

      <section class="mt-8">
        <h2 class="text-lg font-medium">
          Предпросмотр (на демо-выписке)
        </h2>
        <p class="mt-1 text-sm text-(--b24ui-color-text-secondary)">
          Что попадёт в чат при текущих правилах:
        </p>
        <ul
          data-testid="preview-list"
          class="mt-3 space-y-1"
        >
          <li
            v-for="row in preview"
            :key="row.item.docId"
            class="flex items-center justify-between rounded-lg border border-(--b24ui-color-design-tinted-na-stroke) px-3 py-2 text-sm"
          >
            <span>{{ row.item.counterparty.name }} · {{ row.item.purpose }}</span>
            <span
              class="ml-3 shrink-0 rounded-md px-2 py-0.5 text-xs font-medium"
              :class="row.notify
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
                : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-400'"
            >
              {{ row.notify ? '→ в чат' : 'скрыто' }}
            </span>
          </li>
        </ul>
      </section>
    </ClientOnly>
  </main>
</template>
