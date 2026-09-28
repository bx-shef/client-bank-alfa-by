<script setup lang="ts">
import { computed } from 'vue'
import { ALFA_KEY_SHOTS } from '~/utils/bankConnectInvite'

// Снимок кабинета банка после шага инструкции на экране владельца счёта `/bank-key` (#19).
//
// ⚠ Какой снимок к какому шагу — из ТОГО ЖЕ манифеста `ALFA_KEY_SHOTS`, что и вложение в
// сообщение чата. Вторая таблица соответствия разошлась бы с первой молча, и на экране стрелка
// указывала бы не на ту кнопку. У шага нет снимка — компонент не рисует ничего.
// ⚠ Картинка — ссылка на себя в полном размере: самый широкий снимок (1633 px) на экране ужат
// больше чем вдвое, и надписи кабинета на нём иначе не прочитать.
const props = defineProps<{ step: number }>()

const shot = computed(() => ALFA_KEY_SHOTS.find(s => s.afterStep === props.step))
</script>

<template>
  <a
    v-if="shot"
    :href="`/${shot.file}`"
    target="_blank"
    rel="noopener"
    title="Открыть в полном размере"
    class="mt-2 block"
    :data-testid="`guide-shot-${step}`"
  >
    <img
      :src="`/${shot.file}`"
      :alt="shot.name"
      :width="shot.width"
      :height="shot.height"
      loading="lazy"
      decoding="async"
      class="h-auto max-w-full rounded-md border border-(--ui-color-base-5)"
    >
  </a>
</template>
