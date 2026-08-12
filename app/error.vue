<script setup lang="ts">
import type { NuxtError } from '#app'
import { LANDING_TITLE, pageTitle } from '~/utils/landing'

// Страница ошибки (#425). До неё `nuxt generate` клал в `404.html` голую SPA-оболочку: до гидрации
// пустой экран, после — дефолтная страница Nuxt с чужим брендингом и английским текстом. nginx
// отдаёт этот документ на 404 и 403 (`error_page`), то есть это первое, что видит человек,
// опечатавшийся в адресе, — и единственная страница сайта, которую мы никому не показывали.
//
// ⚠ Этот компонент рисуется НА КЛИЕНТЕ: `nuxt generate` кладёт в `404.html` SPA-оболочку и рендерить
// страницу ошибки в неё не умеет (добавление `/404.html` в пререндер ничего не меняет — проверено на
// сборке). Значит и `useHead` отсюда краулер не увидит: `noindex` в сам артефакт вписывает
// `injectNoindex` в `scripts/seo-files.mjs`. Тег ниже — для клиента и для полноты картины, но
// полагаться на него как на единственный источник нельзя.
const props = defineProps<{ error: NuxtError }>()

const isNotFound = computed(() => props.error?.statusCode === 404)

useHead({
  title: pageTitle(isNotFound.value ? 'Страница не найдена' : 'Ошибка'),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }]
})
</script>

<template>
  <B24App>
    <main class="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-4 text-center">
      <p class="text-5xl font-bold text-(--ui-color-base-4)">
        {{ error?.statusCode ?? 500 }}
      </p>
      <h1 class="text-2xl font-bold text-(--ui-color-base-1)">
        {{ isNotFound ? 'Такой страницы нет' : 'Что-то пошло не так' }}
      </h1>
      <p class="text-(--ui-color-base-3)">
        {{ isNotFound
          ? 'Возможно, адрес набран с опечаткой или страницу переименовали.'
          : 'Мы уже знаем о проблеме. Попробуйте обновить страницу или зайти позже.' }}
      </p>
      <B24Button
        to="/"
        label="На главную"
        color="air-primary"
        size="lg"
        class="mt-2"
      />
      <p class="mt-6 text-xs text-(--ui-color-base-4)">
        {{ LANDING_TITLE }}
      </p>
    </main>
  </B24App>
</template>
