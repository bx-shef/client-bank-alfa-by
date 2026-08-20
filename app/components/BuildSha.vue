<script setup lang="ts">
import { computed } from 'vue'
import { commitUrl, shortSha } from '~/utils/build'

// Shared: a link to the exact build commit.
const { public: { commitSha } } = useRuntimeConfig()

const sha = computed(() => shortSha(commitSha as string))
const href = computed(() => commitUrl(commitSha as string))
</script>

<template>
  <!-- `data-testid` — якорь для маски в визуальных регресс-тестах (#3): SHA сборки отличается
       в каждом прогоне, и без маски эталон расходился бы ВСЕГДА. -->
  <B24Link
    :href="href"
    is-action
    data-testid="build-sha"
    class="text-xs"
    target="_blank"
    rel="noopener noreferrer"
  >
    сборка {{ sha || 'dev' }}
  </B24Link>
</template>
