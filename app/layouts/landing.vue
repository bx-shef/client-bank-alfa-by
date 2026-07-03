<script setup lang="ts">
import { ru } from '@bitrix24/b24ui-nuxt/locale'
import GitHubIcon from '@bitrix24/b24icons-vue/social/GitHubIcon'
import Bitrix24Icon from '@bitrix24/b24icons-vue/common-service/Bitrix24Icon'
import ContactDetailsIcon from '@bitrix24/b24icons-vue/outline/ContactDetailsIcon'
import ReceiptIcon from '@bitrix24/b24icons-vue/outline/ReceiptIcon'
import OpenBookIcon from '@bitrix24/b24icons-vue/main/OpenBookIcon'
import ThemeIcon from '@bitrix24/b24icons-vue/outline/ThemeIcon'
import CodeIcon from '@bitrix24/b24icons-vue/common-service/CodeIcon'
import AppsIcon from '@bitrix24/b24icons-vue/solid/AppsIcon'
import DeveloperResourcesIcon from '@bitrix24/b24icons-vue/solid/DeveloperResourcesIcon'
import LogInIcon from '@bitrix24/b24icons-vue/outline/LogInIcon'
import { LANDING_MARKET_URL } from '~/utils/landing'

// Public-landing chrome ported from offer.bx-shef.by (bx-shef Lp): dark branded
// header + footer + business card. Scoped to this layout so the in-portal pages
// (/app, /settings, /login, /queues) keep their own light/dark-auto theme.
const cardOpen = ref(false)

const navItems = [
  [
    {
      label: 'В Маркете Bitrix24',
      icon: Bitrix24Icon,
      to: LANDING_MARKET_URL,
      target: '_blank'
    },
    {
      label: 'Реквизиты',
      icon: ReceiptIcon,
      to: 'https://offer.bx-shef.by/legal',
      target: '_blank'
    },
    {
      label: 'Документация',
      icon: OpenBookIcon,
      children: [
        { label: 'b24ui', icon: ThemeIcon, to: 'https://bitrix24.github.io/b24ui/', target: '_blank' },
        { label: 'b24jssdk', icon: CodeIcon, to: 'https://bitrix24.github.io/b24jssdk/', target: '_blank' },
        { label: 'b24icons', icon: AppsIcon, to: 'https://bitrix24.github.io/b24icons/', target: '_blank' },
        { label: 'REST API', icon: DeveloperResourcesIcon, to: 'https://apidocs.bitrix24.ru/', target: '_blank' }
      ]
    },
    {
      // Служебная зона операторов (вход для сотрудников → /queues и т.д.).
      label: 'Операторам',
      icon: LogInIcon,
      to: '/login'
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
