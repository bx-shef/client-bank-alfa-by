<script setup lang="ts">
import { computed } from 'vue'
import { useChatSettings } from '~/composables/useChatSettings'
import { B24_PAYMENT_TRIGGER } from '~/config/b24'

// Раздел «Авто-проведение оплат» (#530): мутационный гейт §2.

const { settings } = useChatSettings()

// Стадия оплаченного счёта: простая строка поверх необязательного вложенного поля. Пусто ⇒ ключ
// удаляем, чтобы сохранённый блоб оставался минимальным (сервер читает это как «стадию не трогаем»).
const invoicePaidStageModel = computed<string>({
  get: () => settings.allocation.invoicePaidStageId ?? '',
  set: (v) => {
    const s = v.trim()
    if (s) settings.allocation.invoicePaidStageId = s
    else delete settings.allocation.invoicePaidStageId
  }
})

// Код триггера автоматизации (#79): приложение регистрирует канонический триггер на установке,
// админ вешает его на своё правило и вписывает код сюда. Пусто ⇒ ключ удалён ⇒ гейт воркера
// `autoDistribute && triggerCode` остаётся выключенным.
const triggerCodeModel = computed<string>({
  get: () => settings.allocation.triggerCode ?? '',
  set: (v) => {
    const s = v.trim()
    if (s) settings.allocation.triggerCode = s
    else delete settings.allocation.triggerCode
  }
})
const paymentTrigger = B24_PAYMENT_TRIGGER
</script>

<template>
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
