<script setup lang="ts">
import { START_YEAR, copyrightYears } from '~/utils/landing'
import BuildSha from '~/components/BuildSha.vue'

// Shared footer: author + a link to the exact build commit. Used on the landing
// and the in-portal app page.
const { public: { authorName, authorUrl } } = useRuntimeConfig()

const years = copyrightYears(START_YEAR, new Date().getFullYear())
</script>

<template>
  <B24Footer class="w-full border-t border-(--ui-color-divider-default) divide-y divide-(--ui-color-divider-default) min-h-0">
    <template #left>
      <ProseP small accent="less">
        Copyright © {{ years }}
      </ProseP>
    </template>

    <B24NavigationMenu :items="items" variant="link" />

    <template #right>
      <BuildSha />
    </template>
  </B24Footer>
  <footer class="mt-16 flex flex-col items-center gap-1 text-center text-sm text-(--b24ui-color-text-secondary)">
    <span>
      <a
        :href="authorUrl"
        class="underline"
        target="_blank"
        rel="noopener noreferrer"
      >{{ authorName }}</a>
    </span>
  </footer>
</template>
