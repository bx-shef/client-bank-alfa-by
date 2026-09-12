<script setup lang="ts">
import { computed } from 'vue'
import { commitUrl, shortSha } from '~/utils/build'

// Ссылка на КОММИТ сборки: по ней с любого экрана видно, какой именно код сейчас работает.
const { public: { commitSha, repoUrl } } = useRuntimeConfig()

const sha = computed(() => shortSha(commitSha as string))
// ⚠ Репозиторий — из конфигурации, а не зашитый: у клиентского клона он свой, и без этого подпись
// вела бы в репозиторий апстрима, куда у клиента доступа нет (docs/DEPLOY_BITRIXVM.md).
const href = computed(() => commitUrl(commitSha as string, repoUrl as string))
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
