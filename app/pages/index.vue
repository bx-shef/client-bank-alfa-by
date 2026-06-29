<script setup lang="ts">
import { LANDING_FEATURES, copyrightYears } from '~/utils/landing'

const { public: { authorName, authorUrl } } = useRuntimeConfig()

const features = LANDING_FEATURES
const years = copyrightYears(2026, new Date().getFullYear())
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-(--ui-container) flex-col px-6 py-16">
    <section class="flex flex-1 flex-col items-center justify-center text-center">
      <h1 class="text-3xl font-semibold sm:text-5xl">
        Клиент-банк Альфа-Банк Беларусь
      </h1>
      <p class="mt-4 max-w-2xl text-base text-(--b24ui-color-text-secondary) sm:text-lg">
        Приложение для получения выписки из клиент-банка Альфа-Банк Беларусь.
      </p>

      <ul class="mt-12 grid w-full max-w-4xl gap-6 sm:grid-cols-3">
        <li
          v-for="feature in features"
          :key="feature.title"
          class="rounded-2xl border border-(--b24ui-color-design-tinted-na-stroke) p-6 text-left"
        >
          <h2 class="text-lg font-medium">
            {{ feature.title }}
          </h2>
          <p class="mt-2 text-sm text-(--b24ui-color-text-secondary)">
            {{ feature.description }}
          </p>
        </li>
      </ul>
    </section>

    <footer class="mt-16 text-center text-sm text-(--b24ui-color-text-secondary)">
      © {{ years }}
      <a
        :href="authorUrl"
        class="underline"
        target="_blank"
        rel="noopener"
      >{{ authorName }}</a>
    </footer>
  </main>
</template>
