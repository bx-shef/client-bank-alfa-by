<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_SETTINGS } from '~/config/b24'
import { pageTitle } from '~/utils/landing'

// Экран настроек, открываемый слайдером портала.
//
// Страница держит только оболочку: шапку и механику закрытия. Сама форма — это `SettingsForm.vue`
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
      :b24ui="{ body: 'flex flex-col gap-4 flex-1 overflow-y-auto sm:p-4 sm:pt-0 scrollbar-thin' }"
    >
      <template #header>
        <B24DashboardNavbar
          :toggle="false"
          title="Настройки"
        />
      </template>

      <template #body>
        <ClientOnly>
          <!-- `as-slider` включает в форме пару Save/Cancel, которая эмитит `close`: экран
               закрывается сам, как это делал прежний `B24Slideover`. -->
          <SettingsForm
            class="flex flex-col items-center justify-center min-h-full shrink-0"
            @close="close"
          />
        </ClientOnly>
      </template>
    </B24DashboardPanel>
  </InPortalGate>
</template>
