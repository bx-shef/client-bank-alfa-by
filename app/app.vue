<script setup lang="ts">
// ⚠ ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ SEO-МЕТЫ (#425). Корневой компонент применяется ко ВСЕМ страницам,
// включая служебные (`/app`, `/import`, `/install`, `/login`, `/queues`) — они пререндерятся в
// статику и отдаются публично. Пока `useSeoMeta` стоял тут, каждая из них уносила в выдачу
// заголовок, описание и og-картинку ЛЕНДИНГА, то есть плодила его дубли. У соседнего
// `ai-price-import` это подтвердилось на живом проде (`/app` отдавал `og:title` лендинга).
// Мета живёт на страницах: `pages/index.vue` и `pages/partners.vue` — публичные, служебные несут
// `robots: noindex`. Регрессию стережёт `tests/seoMetaPlacement.test.ts`.

// b24ui colorMode persists the choice under this @vueuse/core key; the inline
// theme-init script below reads it to set the class before paint. Keep in sync
// with b24ui's `colorModeStorageKey` default.
const COLOR_MODE_STORAGE_KEY = 'vueuse-color-scheme'

useHead({
  htmlAttrs: { lang: 'ru' },
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }
  ],
  script: [
    {
      // FOUC guard for SSG: b24ui colorMode (vueuse) sets the class only on the
      // client, so we apply the stored/OS theme before first paint. Defaults to
      // `auto` (OS) when nothing is stored; anything non-"light" is treated as dark.
      key: 'theme-init',
      tagPosition: 'head',
      tagPriority: 'critical',
      // The public landing (layout `landing`) forces dark via htmlAttrs
      // `data-force-dark`; honor it here so this early script doesn't repaint it
      // to the OS theme on first paint. In-portal pages don't set the flag and
      // keep their light/dark-auto behavior.
      innerHTML: `(function(){try{var el=document.documentElement,c=el.classList;if(el.getAttribute("data-force-dark")==="true"){c.add("dark");c.remove("light");return;}var s=localStorage.getItem("${COLOR_MODE_STORAGE_KEY}")||"auto";if(s==="auto"){s=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}var d=s!=="light";c.toggle("dark",d);c.toggle("light",!d);}catch(e){}})();`
    }
  ]
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
