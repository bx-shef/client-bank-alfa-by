<script setup lang="ts">
import { onMounted } from 'vue'
import { useB24 } from '~/composables/useB24'
import { pageTitle } from '~/utils/landing'

// Manual statement upload page (P4). In-portal (`clear` layout → b24ui theming);
// also usable standalone (parsing is client-side, no portal needed for preview).
definePageMeta({ layout: 'clear' })

useHead({ title: pageTitle('Загрузка выписки') })

const b24 = useB24()
onMounted(async () => {
  await b24.init()
  if (!b24.isInit()) return
  try {
    const $b24 = b24.getOrThrow()
    await $b24.parent.setTitle('Загрузка выписки')
    await $b24.parent.fitWindow()
  } catch (e) {
    if (import.meta.dev) console.warn('[import] B24 parent calls failed', e)
  }
})
</script>

<template>
  <main class="mx-auto max-w-5xl px-4 py-6">
    <h1 class="text-2xl font-semibold">
      Загрузка выписки
    </h1>
    <p class="mt-2 text-sm text-(--ui-color-base-3)">
      Когда нет онлайн-подключения к банку — загрузите файл выписки, приложение
      разберёт операции. Поддерживаются форматы 1С и client-bank (windows-1251).
    </p>

    <ClientOnly>
      <StatementUpload class="mt-6" />
    </ClientOnly>
  </main>
</template>
