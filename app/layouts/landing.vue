<script setup lang="ts">
import { ru } from '@bitrix24/b24ui-nuxt/locale'
import GitHubIcon from '@bitrix24/b24icons-vue/social/GitHubIcon'
import Bitrix24Icon from '@bitrix24/b24icons-vue/common-service/Bitrix24Icon'
import ContactDetailsIcon from '@bitrix24/b24icons-vue/outline/ContactDetailsIcon'
import ReceiptIcon from '@bitrix24/b24icons-vue/outline/ReceiptIcon'

// Public-landing chrome ported from offer.bx-shef.by (bx-shef Lp): dark branded
// header + footer + business card. Scoped to this layout so the in-portal pages
// (/app, /settings, /login, /queues) keep their own light/dark-auto theme.
const cardOpen = ref(false)

const navItems = [
  [
    {
      label: 'Реквизиты',
      icon: ReceiptIcon,
      to: 'https://offer.bx-shef.by/legal',
      target: '_blank'
    }
  ]
]

// Force dark for the landing document only: the flag is honored by the
// theme-init script in app.vue and by `.dark` styling below. In-portal pages
// don't set it and follow the OS/user color-mode.
useHead({
  htmlAttrs: {
    'class': 'dark',
    'data-force-dark': 'true'
  },
  meta: [
    { name: 'theme-color', content: '#030022' }
  ]
})
</script>

<template>
  <B24App
    :locale="ru"
    class="landing-shell dark"
  >
    <B24Header>
      <template #left>
        <NuxtLink
          to="/"
          class="flex items-center gap-3"
        >
          <AppLogo class="w-auto h-[40px] shrink-0" />
        </NuxtLink>
      </template>

      <B24NavigationMenu :items="navItems" />

      <template #right>
        <B24Button
          aria-label="Визитка"
          color="air-tertiary-no-accent"
          :icon="ContactDetailsIcon"
          size="sm"
          @click="cardOpen = true"
        />
      </template>
      <template #body>
        <B24NavigationMenu
          :items="navItems"
          orientation="vertical"
        />
      </template>
    </B24Header>

    <B24Main>
      <slot />
    </B24Main>

    <B24Separator :icon="Bitrix24Icon" />

    <B24Footer>
      <template #left>
        <SiteFooter />
      </template>
      <template #right>
        <B24Button
          to="https://github.com/IgorShevchik"
          target="_blank"
          aria-label="GitHub"
          color="air-tertiary-no-accent"
          :icon="GitHubIcon"
          size="sm"
        />
      </template>
    </B24Footer>

    <ClientOnly>
      <BusinessCardModal
        :open="cardOpen"
        @close="cardOpen = false"
      />
    </ClientOnly>
  </B24App>
</template>
