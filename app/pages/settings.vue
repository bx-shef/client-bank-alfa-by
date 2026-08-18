<script setup lang="ts">
import { onMounted, ref } from 'vue'
import CrossMIcon from '@bitrix24/b24icons-vue/outline/CrossMIcon'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_SETTINGS } from '~/config/b24'
import { pageTitle } from '~/utils/landing'

// Экран настроек, открываемый НАСТОЯЩИМ слайдером портала (`openSliderAppPage` с /app).
//
// Страница держит только оболочку: шапку с крестиком и механику закрытия. Сама форма — это
// `SettingsForm.vue`, тот же компонент, что раньше жил в `B24Slideover` внутри /app.
//
// ⚠ Страница обязана существовать как МАРШРУТ: портал переоткрывает приложение по НАШЕМУ адресу и
// передаёт `place`, а глобальный мидлвар уводит свежий фрейм сюда. Без маршрута открывать нечего.
definePageMeta({ layout: 'clear' })

// Служебная страница: пререндерится и отдаётся публично, но в выдаче ей делать нечего — без
// `noindex` она ушла бы в индекс с мета-данными лендинга (#425).
useHead({
  title: pageTitle('Настройки'),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }]
})

const { init, get, placementPlace, closeSlider } = useB24()

// Как экран открыт — от этого зависит, что делает закрытие:
//  • слайдером (`place = app-options`) → закрываем оверлей портала;
//  • обычной навигацией внутри фрейма (портал отказал в слайдере) → возвращаемся на /app;
//  • вне портала → никуда не уходим, закрывать нечего.
// ⚠ `null` — «ещё не знаем»: со стартовым `false` первый кадр считал бы себя standalone.
const inPortal = ref<boolean | null>(null)
const isSlider = ref(false)

onMounted(async () => {
  try {
    await init()
    inPortal.value = !!get()
    isSlider.value = placementPlace() === APP_SLIDER_PLACE_SETTINGS
    if (inPortal.value) await get()?.parent.setTitle('Настройки')
  } catch (e) {
    if (import.meta.dev) console.warn('[settings] B24 init failed', e)
  }
})

/** Закрыть экран так, как он был открыт. */
async function close(): Promise<void> {
  if (isSlider.value) {
    await closeSlider()
    return
  }
  if (inPortal.value) await navigateTo('/app')
}
</script>

<template>
  <InPortalGate>
    <B24DashboardPanel
      id="settings"
      :b24ui="{ body: 'p-4 sm:pt-0 scrollbar-transparent flex flex-col gap-4' }"
    >
      <template #header>
        <B24DashboardNavbar
          :toggle="false"
          title="Настройки"
        >
          <template #leading>
            <B24Button
              :icon="CrossMIcon"
              color="air-tertiary-no-accent"
              size="xs"
              :aria-label="isSlider ? 'Закрыть' : 'Вернуться к обзору'"
              @click="close"
            />
          </template>
        </B24DashboardNavbar>
      </template>

      <!-- ⚠ Именно `#body`, а НЕ дефолтный слот. `B24DashboardPanel` рендерит header/body/footer
           только когда дефолтный слот ПУСТ (в его шаблоне они вложены внутрь `<slot>` как запасной
           вариант). Положив форму в дефолтный слот, мы молча теряем шапку — страница выглядит
           нормально, но крестика и заголовка нет вовсе, и закрыть слайдер нечем. -->
      <template #body>
        <ClientOnly>
          <!-- `as-slider` включает в форме пару Save/Cancel, которая эмитит `close`: экран
               закрывается сам, как это делал прежний `B24Slideover`. -->
          <SettingsForm
            :as-slider="true"
            @close="close"
          />
        </ClientOnly>
      </template>
    </B24DashboardPanel>
  </InPortalGate>
</template>
