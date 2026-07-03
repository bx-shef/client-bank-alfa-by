<script setup lang="ts">
import { LANDING_TITLE, LANDING_DESCRIPTION, ogImageUrl } from '~/utils/landing'

// b24ui colorMode persists the choice under this @vueuse/core key; the inline
// theme-init script below reads it to set the class before paint. Keep in sync
// with b24ui's `colorModeStorageKey` default.
const COLOR_MODE_STORAGE_KEY = 'vueuse-color-scheme'

const title = LANDING_TITLE
const description = LANDING_DESCRIPTION

// og:image should be absolute for scrapers; siteUrl is set via NUXT_PUBLIC_SITE_URL
// in prod (empty in dev → a relative /og.png, which is fine for local preview).
const ogImage = ogImageUrl(useRuntimeConfig().public.siteUrl || '')

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

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogType: 'website',
  ogImage,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageType: 'image/png',
  ogImageAlt: title,
  twitterCard: 'summary_large_image',
  twitterTitle: title,
  twitterDescription: description,
  twitterImage: ogImage
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
