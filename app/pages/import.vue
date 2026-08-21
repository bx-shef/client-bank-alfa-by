<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ArrowLeftMIcon from '@bitrix24/b24icons-vue/outline/ArrowLeftMIcon'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_IMPORT } from '~/config/b24'
import { pageTitle } from '~/utils/landing'
import { useLogger } from '~/utils/logger'

const log = useLogger('import')

// Manual statement upload page (P4). In-portal (`portal` layout → b24ui theming);
// also usable standalone (parsing is client-side, no portal needed for preview).
definePageMeta({ layout: 'portal' })

// Служебная страница: пререндерится в статику и отдаётся публично, но в выдаче ей делать нечего —
// без `noindex` она уходила в индекс с мета-данными ЛЕНДИНГА (#425). Закрываем именно мета-тегом, а
// не `Disallow` в robots.txt: краулер, послушавший `Disallow`, страницу не скачает, не увидит
// `noindex` и вполне может показать голый URL по внешней ссылке.
useHead({
  title: pageTitle('Загрузка выписки'),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }]
})

const b24 = useB24()

// Экран открывается двумя способами, и «назад» у них разное. Слайдером портала (`place`
// `app-import`) — закрываем оверлей; обычной навигацией внутри фрейма — возвращаемся на /app.
// Показывать «К сводке операций» в слайдере нельзя: за ним нет истории, кнопка увела бы фрейм
// слайдера на главный экран, и поверх работы висело бы ВТОРОЕ приложение.
const isSlider = ref(false)

onMounted(async () => {
  await b24.init()
  if (!b24.isInit()) return
  isSlider.value = b24.placementPlace() === APP_SLIDER_PLACE_IMPORT
  try {
    const $b24 = b24.getOrThrow()
    await $b24.parent.setTitle('Загрузка выписки')
    await $b24.parent.fitWindow()
  } catch (e) {
    log.warning('не удалось вызвать parent-методы портала', { error: String(e) })
  }
})
</script>

<!-- Только внутри портала (#414): снаружи нет фрейм-токена, значит запись в CRM невозможна, а
     разбор файла в браузере без неё бессмыслен. -->
<template>
  <InPortalGate>
    <main class="mx-auto max-w-5xl px-4 py-6">
      <!-- Back to the in-portal metrics/operations view (#219 follow-up: /import had no way back).
           ⚠ В слайдере своей кнопки закрытия НЕТ: крестик рисует сам портал, и вторая была бы
           дублем — то же правило, что на странице настроек. -->
      <B24Button
        v-if="!isSlider"
        :icon="ArrowLeftMIcon"
        label="К сводке операций"
        color="air-tertiary-no-accent"
        size="sm"
        to="/app"
        class="mb-4"
      />
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
  </InPortalGate>
</template>
