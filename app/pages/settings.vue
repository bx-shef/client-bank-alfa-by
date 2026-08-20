<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_SETTINGS } from '~/config/b24'
import { pageTitle } from '~/utils/landing'
import { useLogger } from '~/utils/logger'

const log = useLogger('settings')

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

// Состояний ровно ДВА, и это осознанное упрощение: экран открыт слайдером портала — или нет.
// Промежуточное «во фрейме, но не слайдером» отдельной ветки не заслуживает: закрытие там ведёт
// туда же, куда и вне портала, — на /app, а лишнее состояние заставляло бы гадать, в каком мы,
// при каждой правке.
//
// ⚠ Крестик рисует САМ портал — своего мы не ставим. Наше дело только кнопка «Отмена».
const isSlider = ref(false)

onMounted(async () => {
  try {
    await init()
    isSlider.value = placementPlace() === APP_SLIDER_PLACE_SETTINGS
    await get()?.parent.setTitle('Настройки')
  } catch (e) {
    log.warning('рукопожатие с порталом не состоялось', { error: String(e) })
  }
})

/** Закрыть экран так, как он был открыт: слайдер — свернуть, иначе увести на обзор.
 *  Вне портала /app — обычная страница, поэтому тупика не возникает. */
async function close(): Promise<void> {
  if (isSlider.value) {
    await closeSlider()
    return
  }
  await navigateTo('/app')
}
</script>

<template>
  <InPortalGate>
    <B24DashboardPanel
      id="settings"
      :b24ui="{ body: 'flex flex-col gap-4 flex-1 overflow-y-auto p-4 sm:pt-0 scrollbar-thin' }"
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
          <!-- Обёртка, а не класс на самой форме: у `SettingsForm` НЕСКОЛЬКО корневых узлов
               (экраны «проверяем доступ» / «только администратору» / «загрузка» / сама форма),
               и атрибуты на такой компонент не наследуются никуда — класс молча пропадал,
               а вместе с ним и высота, по которой центрируются эти экраны. -->
          <div class="flex min-h-full flex-1 flex-col">
            <SettingsForm @close="close" />
          </div>
        </ClientOnly>
      </template>
    </B24DashboardPanel>
  </InPortalGate>
</template>
