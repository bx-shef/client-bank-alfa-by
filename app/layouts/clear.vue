<script setup lang="ts">
// Minimal layout — no site chrome, but inside <B24App> so b24ui components,
// useToast and the colour-mode tokens work correctly. Used both by the in-portal
// Bitrix24 iframe pages (/install, /app, /settings) and by the standalone operator
// pages (/login, /queues), so they theme (light/dark) like the rest of the app.
import { ru } from '@bitrix24/b24ui-nuxt/locale'
</script>

<template>
  <B24App :locale="ru">
    <!-- ⚠ `overflow-x-clip`, а НЕ `overflow-x-hidden` (#530). Горизонтальное переполнение оба
         режут одинаково, но `hidden` вдобавок делает элемент СКРОЛЛПОРТОМ (CSS: при
         `overflow-x: hidden` вычисленный `overflow-y` перестаёт быть `visible`), а `clip` — нет.
         Замерено: под `hidden` любой `position: sticky` на всех in-portal-страницах молча
         переставал липнуть — он привязывался к этому контейнеру, а тот, будучи `min-h-screen`,
         сам никогда не прокручивается (прокручивается документ). Полоса разделов настроек уезжала
         вместе со страницей: после прокрутки на 900 px её верх оказывался на −740. -->
    <div class="min-h-screen w-screen overflow-x-clip bg-(--ui-color-base-bg)">
      <slot />
    </div>
  </B24App>
</template>
