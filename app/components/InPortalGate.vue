<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import LoaderWaitIcon from '@bitrix24/b24icons-vue/animated/LoaderWaitIcon'
import Market1Icon from '@bitrix24/b24icons-vue/main/Market1Icon'
import { useRoute } from 'vue-router'
import { useB24 } from '~/composables/useB24'
import { isPreviewQuery, portalGateState } from '~/utils/inPortalGate'
import { LANDING_MARKET_URL } from '~/utils/landing'

// Гейт «только внутри Bitrix24» (#414). Оборачивает тело страниц приложения.
//
// Зачем: снаружи портала у страниц нет фрейм-токена — не грузятся настройки, не читается статус,
// нельзя записать в CRM. Интерфейс при этом выглядел рабочим, что вводило в заблуждение (а до
// удаления демо-мока ещё и показывал выдуманные цифры).
//
// ⚠ Это UX-заглушка, НЕ авторизация: скрипт страницы отрабатывает в любом случае, а настоящая
// граница — фрейм-токен на сервере. Вешать на `portalGateState` реальную проверку доступа нельзя.
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

// Спиннер показываем не сразу: рукопожатие с порталом обычно укладывается в доли секунды, и
// мгновенная отрисовка «Проверяем…» была бы ровно тем миганием, ради которого состояние заведено.
const showSpinner = ref(false)
/** Потолок ожидания рукопожатия — как у `/install`. */
const HANDSHAKE_TIMEOUT_MS = 10_000
let spinnerTimer: ReturnType<typeof setTimeout> | undefined
const stub = ref<HTMLElement | null>(null)

onMounted(async () => {
  spinnerTimer = setTimeout(() => {
    showSpinner.value = true
  }, 250)
  const b24 = useB24()
  // Ждём рукопожатие с ОГРАНИЧЕНИЕМ по времени: у `initializeB24Frame` своего таймаута нет, и
  // зависший handshake (например чужой/устаревший iframe с выставленным `window.name`) оставил бы
  // страницу в «проверяем» навсегда — без интерфейса и без объяснения. `/install` тот же вызов
  // тоже ограничивает 10 секундами.
  await Promise.race([
    b24.init().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, HANDSHAKE_TIMEOUT_MS))
  ])
  // ⚠ Читаем `get()`, а не `isInit()`: реактивный флаг внутри `useB24` выставляется в `nextTick`,
  // поэтому сразу после `await init()` он ещё «снаружи» — сейчас это работает лишь по случайному
  // порядку микрозадач. На этом гейте такая ошибка означала бы заглушку «откройте внутри
  // Bitrix24», показанную ВНУТРИ Bitrix24.
  inPortal.value = b24.get() !== undefined
  resolved.value = true
  clearTimeout(spinnerTimer)
  // Экранный диктор объявил «Проверяем подключение…» — без переноса фокуса он остался бы на этом
  // объявлении и не узнал бы, чем всё кончилось.
  if (!inPortal.value && !preview.value) {
    await nextTick()
    // ref на КОМПОНЕНТ отдал бы инстанс, а не элемент (у него нет focus) — поэтому ref
    // стоит на контейнере, и ему нужен tabindex: без него элемент не фокусируем вовсе.
    stub.value?.focus()
  }
})

onUnmounted(() => {
  clearTimeout(spinnerTimer)
})
</script>

<template>
  <ClientOnly>
    <slot v-if="state === 'ok'" />

    <!-- Высота фиксированная и небольшая: внутри iframe портала высоту задаёт `fitWindow`, и `60vh`
         разворачивались бы в пустую полосу или прокрутку на коротком фрейме. -->
    <div
      v-else-if="state === 'checking'"
      role="status"
      aria-live="polite"
      class="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-3 px-4 text-center"
      data-testid="portal-gate-checking"
    >
      <template v-if="showSpinner">
        <LoaderWaitIcon
          class="size-12"
          aria-hidden="true"
        />
        <ProseP
          accent="less"
          small
        >
          Проверяем подключение к Bitrix24…
        </ProseP>
      </template>
    </div>

    <div
      v-else
      ref="stub"
      class="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-1 px-4 text-center"
      tabindex="-1"
      data-testid="portal-gate-outside"
    >
      <ProseH3 class="mb-0">
        Откройте приложение внутри Bitrix24
      </ProseH3>
      <ProseP accent="less">
        Найдите приложение в левом меню портала — или установите его из
        Маркета, если ещё не установили.
      </ProseP>
      <!-- Обе ссылки внешние и в новой вкладке: внутри iframe портала переход увёл бы сам фрейм на
           лендинг, откуда в приложение уже не вернуться. -->
      <div class="mt-1 flex flex-wrap items-center justify-center gap-2">
        <B24Button
          label="Установить из Маркета"
          color="air-secondary-accent-2"
          :icon="Market1Icon"
          :href="LANDING_MARKET_URL"
          target="_blank"
          rel="noopener"
        />
        <B24Button
          label="О приложении"
          color="air-secondary-accent"
          size="sm"
          href="/"
          target="_blank"
          rel="noopener"
        />
      </div>
    </div>
  </ClientOnly>
</template>
