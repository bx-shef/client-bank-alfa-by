<script setup lang="ts">
import { LANDING_TITLE, LANDING_DESCRIPTION } from '~/utils/landing'

// b24ui colorMode persists the choice under this @vueuse/core key; the inline
// theme-init script below reads it to set the class before paint. Keep in sync
// with b24ui's `colorModeStorageKey` default.
const COLOR_MODE_STORAGE_KEY = 'vueuse-color-scheme'

const title = LANDING_TITLE
const description = LANDING_DESCRIPTION

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
      innerHTML: `(function(){try{var s=localStorage.getItem("${COLOR_MODE_STORAGE_KEY}")||"auto";if(s==="auto"){s=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}var d=s!=="light";var c=document.documentElement.classList;c.toggle("dark",d);c.toggle("light",!d);}catch(e){}})();`
    }
  ]
})

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogType: 'website'
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
