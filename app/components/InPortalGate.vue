<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import LoaderWaitIcon from '@bitrix24/b24icons-vue/animated/LoaderWaitIcon'
import { useRoute } from 'vue-router'
import { useB24 } from '~/composables/useB24'
import { isPreviewQuery, portalGateState } from '~/utils/inPortalGate'
import { LANDING_TITLE } from '~/utils/landing'

// Гейт «только внутри Bitrix24» (#414). Оборачивает тело страниц приложения.
//
// Зачем: снаружи портала у страниц нет фрейм-токена — не грузятся настройки, не читается статус,
// нельзя записать в CRM. Интерфейс при этом выглядел рабочим, что вводило в заблуждение (а до
// удаления демо-мока ещё и показывал выдуманные цифры).
//
// Состояние «проверяем» обязательно: `useB24().init()` асинхронный, и без него страница мелькнула
// бы интерфейсом и схлопнулась в заглушку — это читается как поломка.
//
// `?preview=1` — осознанный обход для разработки и скриншотов (прецедент — `/queues`). Без него
// покраснели бы тесты, монтирующие страницы вне фрейма, и перестала бы работать визуальная приёмка.

const resolved = ref(false)
const inPortal = ref(false)
// Флаг читаем ИЗ РОУТЕРА, а не из `window.location`: на гидратации SSG-страницы Nuxt на короткий
// момент подменяет адрес пререндеренным путём БЕЗ строки запроса, и чтение `location.search` в
// `onMounted` возвращало пустую строку — обход молча не работал (проверено на собранной статике).
const route = useRoute()
const preview = computed(() => isPreviewQuery(route.query.preview))

const state = computed(() => portalGateState({
  resolved: resolved.value,
  inPortal: inPortal.value,
  preview: preview.value
}))

onMounted(async () => {
  const b24 = useB24()
  await b24.init().catch(() => {})
  inPortal.value = b24.isInit()
  resolved.value = true
})
</script>

<template>
  <ClientOnly>
    <slot v-if="state === 'ok'" />

    <div
      v-else-if="state === 'checking'"
      role="status"
      aria-live="polite"
      class="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-(--ui-color-base-3)"
      data-testid="portal-gate-checking"
    >
      <LoaderWaitIcon
        class="size-8"
        aria-hidden="true"
      />
      <p class="text-sm">
        Проверяем подключение к Битрикс24…
      </p>
    </div>

    <div
      v-else
      class="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-4 px-4 text-center"
      data-testid="portal-gate-outside"
    >
      <h1 class="text-xl font-semibold">
        Откройте приложение внутри Битрикс24
      </h1>
      <p class="text-sm text-(--ui-color-base-3)">
        Эта страница работает только как приложение портала: снаружи у неё нет доступа к вашим
        настройкам, выписке и CRM. Откройте «{{ LANDING_TITLE }}» в левом меню портала — или
        установите приложение, если ещё не установили.
      </p>
      <B24Button
        label="О приложении"
        color="air-secondary-no-accent"
        size="sm"
        to="/"
      />
    </div>
  </ClientOnly>
</template>
