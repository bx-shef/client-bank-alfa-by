<script setup lang="ts">
// Minimal layout — no site chrome, but inside <B24App> so b24ui components,
// useToast and the colour-mode tokens work correctly. Used both by the in-portal
// Bitrix24 iframe pages (/install, /app, /settings) and by the standalone operator
// pages (/login, /queues), so they theme (light/dark) like the rest of the app.
import { ru } from '@bitrix24/b24ui-nuxt/locale'
</script>

<template>
  <B24App :locale="ru">
    <div class="min-h-screen w-screen overflow-x-hidden bg-(--ui-color-base-bg)">
      <slot />
    </div>
  </B24App>
</template>
