<script setup lang="ts">
import { onActivated, onMounted, ref, watch } from 'vue'
import { useChatSettings } from '~/composables/useChatSettings'
import { parseRuleLines } from '~/utils/statement'

// Раздел «Исключения» (#530): операции, пропускаемые ЦЕЛИКОМ.

const { settings } = useChatSettings()

// Текстовые поля правят построчные списки; зеркалим их в настройки через `parseRuleLines`.
//
// ⚠ Посев идёт на монтировании И на ВОЗВРАЩЕНИИ из кэша. Второе не перестраховка: раздел живёт
// под `KeepAlive`, поэтому уход на соседний раздел его НЕ размонтирует — `onMounted` при возврате
// уже не позовут. Замерено: без `onActivated` «Отмена» перечитывала настройки с сервера, а в
// текстовом поле оставался отменённый текст, и первое же нажатие клавиши возвращало его обратно
// в настройки через `watch` ниже. То есть отменённая правка тихо воскресала и сохранялась.
//
// ⚠ Повторный посев безопасен: всё, что человек ввёл, `watch` уже зеркалит в настройки на каждом
// вводе, поэтому посев из настроек возвращает ровно тот же текст.
const accountsText = ref('')
const patternsText = ref('')
function seed() {
  accountsText.value = (settings.chat.rules.excludeAccounts ?? []).join('\n')
  patternsText.value = (settings.chat.rules.excludePurposePatterns ?? []).join('\n')
}
onMounted(seed)
onActivated(seed)
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
