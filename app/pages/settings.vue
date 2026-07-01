<script setup lang="ts">
import { onMounted } from 'vue'
import { useB24 } from '~/composables/useB24'
import { pageTitle } from '~/utils/landing'

// In-portal page: `clear` layout wraps it in <B24App> for iframe theming.
// This full-page route is the fallback / direct link; the primary entry is the
// settings slideover opened from /app (both render the same <SettingsForm/>).
definePageMeta({ layout: 'clear' })

useHead({ title: pageTitle('Настройки') })

const b24 = useB24()
onMounted(async () => {
  await b24.init()
  if (!b24.isInit()) return
  try {
    const $b24 = b24.getOrThrow()
    await $b24.parent.setTitle('Настройки')
    await $b24.parent.fitWindow()
  } catch (e) {
    if (import.meta.dev) console.warn('[settings] B24 parent calls failed', e)
  }
})
</script>

<template>
  <main class="mx-auto max-w-5xl px-4 py-6">
    <h1 class="text-2xl font-semibold">
      Настройки
    </h1>

    <B24Alert
      color="air-primary-warning"
      variant="soft"
      title="Демо-режим"
      description="Настройки хранятся локально в браузере, ключ API не сохраняется. Реальное хранение — на сервере."
      class="mt-3"
    />

    <ClientOnly>
      <SettingsForm class="mt-6" />
    </ClientOnly>
  </main>
</template>
