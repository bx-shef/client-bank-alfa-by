<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useChatSettings } from '~/composables/useChatSettings'
import { parseRuleLines } from '~/utils/statement'

// Раздел «Исключения» (#530): операции, пропускаемые ЦЕЛИКОМ.

const { settings } = useChatSettings()

// Текстовые поля правят построчные списки; зеркалим их в настройки через `parseRuleLines`.
//
// ⚠ Посев идёт в `onMounted`, а не один раз на уровне модуля: раздел монтируется, когда на него
// переключились, и к этому моменту настройки уже загружены. Без посева поля были бы пустыми, а
// первое же нажатие клавиши затёрло бы сохранённые правила пустым списком.
const accountsText = ref('')
const patternsText = ref('')
onMounted(() => {
  accountsText.value = (settings.chat.rules.excludeAccounts ?? []).join('\n')
  patternsText.value = (settings.chat.rules.excludePurposePatterns ?? []).join('\n')
})
watch(accountsText, v => (settings.chat.rules.excludeAccounts = parseRuleLines(v)))
watch(patternsText, v => (settings.chat.rules.excludePurposePatterns = parseRuleLines(v)))
</script>

<template>
  <div class="space-y-4">
    <p class="text-sm text-(--ui-color-base-3)">
      Такие операции <strong>полностью пропускаются</strong>: не создаётся дело в CRM и не уходит
      уведомление в чат. (Чтобы просто не слать в чат, но заносить в CRM — используйте
      переключатели «Приходы/Расходы» в разделе «Уведомления в чат».)
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
