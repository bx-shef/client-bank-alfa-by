<script setup lang="ts">
import { computed } from 'vue'
import { useChatSettings } from '~/composables/useChatSettings'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { isExcludedOperation, shouldNotifyChat } from '~/utils/statement'

// Живой предпросмотр правил чата — главная обратная связь настроек: единственное место, где видно
// последствия правил ДО сохранения.
//
// ⚠ Для каждой демо-операции считаем ДВА разных исхода: исключённая не попадает в CRM вовсе, а
// «тихая» попадает, просто без сообщения. Свести их в одно «скрыто» — значит соврать про CRM.
//
// ⚠ Блок однажды уже был потерян при перестройке вёрстки, и вместе с ним умерли восемь тестов. Без
// него «Приходы/Расходы» и «Исключения» — три поля, эффект которых узнаёшь на живых платежах.

const { settings } = useChatSettings()

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
  <B24Card>
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
        <!-- Три РАЗНЫХ исхода: исключена из импорта / импортируется, но молча / в чат. -->
        <B24Badge
          :label="row.excluded ? 'не импортируется' : row.notify ? '→ в чат' : 'скрыто в чате'"
          :color="row.excluded ? 'air-primary-alert' : row.notify ? 'air-primary-success' : 'air-secondary'"
          size="sm"
          class="shrink-0"
        />
      </li>
    </ul>
  </B24Card>
</template>
