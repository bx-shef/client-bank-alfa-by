<script setup lang="ts">
import { computed } from 'vue'
import { useChatSettings } from '~/composables/useChatSettings'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { isDirectionEnabled, isExcludedOperation, shouldImportOperation } from '~/utils/statement'

// Живой предпросмотр правил чата — главная обратная связь настроек: единственное место, где видно
// последствия правил ДО сохранения.
//
// ⚠ ИСХОДА ТЕПЕРЬ ДВА, А НЕ ТРИ (#44). Прежде третьим был «импортируется, но молча»: направление
// фильтровало только чат, и операция всё равно попадала в CRM. Теперь снятая галка направления —
// гейт ЗАГРУЗКИ, поэтому не-оповещаемых-но-записанных операций в модели не существует вовсе.
// Оставить бейдж «скрыто в чате» значило бы обещать запись, которой не будет, — на единственном
// экране, где админ видит последствия галок ДО сохранения.
//
// ⚠ Причина «не импортируется» при этом РАЗНАЯ, и она называется: список исключений (плательщик)
// или выключенное направление (вид операции). Чинятся они в разных полях этой же формы, поэтому
// свести их в одну подпись — значит отправить человека искать не там.
//
// ⚠ Блок однажды уже был потерян при перестройке вёрстки, и вместе с ним умерли восемь тестов. Без
// него «Приходы/Расходы» и «Исключения» — три поля, эффект которых узнаёшь на живых платежах.

const { settings } = useChatSettings()

const preview = computed(() =>
  MOCK_STATEMENT.items.map(item => ({
    item,
    excluded: isExcludedOperation(item, settings.chat.rules),
    directionOff: !isDirectionEnabled(item, settings.chat.rules),
    imported: shouldImportOperation(item, settings.chat.rules)
  }))
)
const importedCount = computed(() => preview.value.filter(r => r.imported).length)
/** Не импортируется ПО ЛЮБОЙ причине — и по исключениям, и по выключенному направлению (#44). */
const droppedCount = computed(() => preview.value.filter(r => !r.imported).length)
const previewSummary = computed(() => {
  const base = `В чат попадёт ${importedCount.value} из ${preview.value.length} операций`
  return droppedCount.value > 0 ? `${base}, ${droppedCount.value} — не импортируется` : base
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

    <!-- ⚠ Текст говорит про ПЕРЕНОС, а не только про чат (#44): при текущих правилах операция не
         попадёт ни в CRM, ни в чат, и обещать «просто не будет сообщений» — неправда. -->
    <B24Alert
      v-if="importedCount === 0"
      color="air-primary-warning"
      description="При текущих правилах ни одна операция не будет перенесена в CRM — и в чат ничего не попадёт."
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
        <!-- ⚠ Два исхода, а не три (#44): операция либо переносится в CRM и идёт в чат, либо не
             переносится вовсе. Причина непереноса НАЗЫВАЕТСЯ — исключения и направление чинятся
             в разных полях этой же формы. -->
        <B24Badge
          :label="row.imported ? '→ в чат' : row.excluded ? 'исключена' : 'направление выключено'"
          :color="row.imported ? 'air-primary-success' : 'air-primary-alert'"
          size="sm"
          class="shrink-0"
        />
      </li>
    </ul>
  </B24Card>
</template>
