<script setup lang="ts">
import { computed } from 'vue'
import { START_YEAR, copyrightYears } from '~/utils/landing'
import { commitUrl, shortSha } from '~/utils/build'

// Shared footer: author + a link to the exact build commit. Used on the landing
// and the in-portal app page.
const { public: { authorName, authorUrl, commitSha } } = useRuntimeConfig()

const years = copyrightYears(START_YEAR, new Date().getFullYear())
const sha = computed(() => shortSha(commitSha as string))
const href = computed(() => commitUrl(commitSha as string))
</script>

<template>
  <footer class="mt-16 flex flex-col items-center gap-1 text-center text-sm text-(--b24ui-color-text-secondary)">
    <span>
      © {{ years }}
      <a
        :href="authorUrl"
        class="underline"
        target="_blank"
        rel="noopener noreferrer"
      >{{ authorName }}</a>
    </span>
    <a
      :href="href"
      class="text-xs underline opacity-70"
      target="_blank"
      rel="noopener noreferrer"
    >сборка {{ sha || 'dev' }}</a>
  </footer>
</template>
