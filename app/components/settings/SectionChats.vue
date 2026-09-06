<script setup lang="ts">
import { computed } from 'vue'
import { useChatSettings } from '~/composables/useChatSettings'
import type { OperationDirection } from '~/types/statement'

// Раздел «Уведомления в чат» (#530): чат уведомлений, направления, чат ошибок.

const { settings, notifyOption, errorOption, chatFetcher } = useChatSettings()

// Переключатели направлений — get/set поверх массива правил.
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
</script>

<template>
  <div class="space-y-4">
    <B24FormField
      label="Чат для уведомлений"
      description="Куда слать сообщения о новых операциях. Переключатели ниже решают, какие операции вообще переносятся в CRM."
    >
      <AsyncSearchSelect
        v-model="settings.chat.dialogId"
        :fetcher="chatFetcher"
        :selected-option="notifyOption"
        clearable
        placeholder="Начните вводить название чата"
        data-testid="notify-chat"
        @update:selected-option="(o: any) => (settings.chat.title = o?.label as string | undefined)"
      />
    </B24FormField>

    <!-- ⚠ Это ГЕЙТ ЗАГРУЗКИ, а не фильтр оповещения (#44). Снятая галка означает, что операция не
         попадёт в CRM вовсе: ни дела, ни записи в смарт-процессе, ни сообщения в чат, ни строки в
         статистике. Подписи обязаны это говорить: прежде они звучали как «о чём писать в чат», и
         человек, снявший галку, не ожидал, что расходы перестанут переноситься. -->
    <B24Alert
      color="air-primary-warning"
      title="Что переносим в CRM"
      description="Выключенное направление не загружается совсем: ни дела, ни записи в смарт-процессе, ни сообщения в чат, ни строки в статистике. Настройка общая на все подключённые банки и счета и действует на будущие операции — уже записанное остаётся в CRM."
      class="mb-1"
    />
    <B24Switch
      v-model="notifyCredit"
      label="Приходы"
      description="переносить поступления на счёт"
      data-testid="notify-credit"
    />
    <B24Switch
      v-model="notifyDebit"
      label="Расходы"
      description="переносить списания со счёта"
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
        clearable
        placeholder="Начните вводить название чата"
        data-testid="error-chat"
        @update:selected-option="(o: any) => (settings.errorChat.title = o?.label as string | undefined)"
      />
    </B24FormField>
  </div>
</template>
