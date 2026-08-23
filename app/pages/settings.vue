<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { NavigationMenuItem } from '@bitrix24/b24ui-nuxt'
import { useB24 } from '~/composables/useB24'
import { APP_SLIDER_PLACE_SETTINGS } from '~/config/b24'
import { pageTitle } from '~/utils/landing'
import { useLogger } from '~/utils/logger'
import {
  DEFAULT_SETTINGS_SECTION,
  resolveSettingsSection,
  SETTINGS_SECTIONS
} from '~/utils/settingsSections'
import type { SettingsSectionId } from '~/utils/settingsSections'

const log = useLogger('settings')

// Активный раздел.
//
// ⚠ Адрес читаем, но НЕ пишем. Читать полезно: экран готовности и письмо могут привести сразу к
// нужному разделу. А запись сюда означала бы навигацию на ПРЕРЕНДЕРЕННОЙ странице внутри фрейма
// слайдера — ровно там, где Nuxt восстанавливает отложенный адрес в обход гардов (#555). Платить
// этим риском за кнопку «назад», которой в слайдере портала нет, незачем.

const route = useRoute()
const section = ref<SettingsSectionId>(DEFAULT_SETTINGS_SECTION)

// Пункты навигации: активный подсвечен, клик переключает раздел.
//
// ⚠ Подсветку даёт `active`, а НЕ `v-model`: `modelValue` у горизонтального меню означает «какое
// подменю раскрыто» и на плоском списке без `children` не делает ничего. `value` тут не про
// подсветку (первая редакция комментария утверждала обратное) — это идентичность пункта для
// reka-ui, и тип прямо просит не оставлять её индексной.

const navItems = computed<NavigationMenuItem[]>(() =>
  SETTINGS_SECTIONS.map(s => ({
    label: s.label,
    value: s.id,
    active: section.value === s.id,
    // ⚠ `preventDefault` здесь НЕ нужен и раньше стоял зря: в `select` приходит не клик, а
    // синтетическое событие reka, и отмена его подавляет лишь закрытие раскрытого подменю —
    // которого у плоских пунктов нет. Читалось же это как «гасим переход по ссылке», хотя
    // переходить некуда: без `to` пункт рендерится нативной кнопкой.
    onSelect: () => {
      section.value = s.id
    }
  }))
)
const currentSection = computed(() => SETTINGS_SECTIONS.find(s => s.id === section.value))

// Экран настроек, открываемый слайдером портала.
//
// Страница держит только оболочку: шапку и механику закрытия. Сама форма — это `SettingsForm.vue`
//
// ⚠ Страница обязана существовать как МАРШРУТ: портал переоткрывает приложение по НАШЕМУ адресу и
// передаёт `place`, а глобальный мидлвар уводит свежий фрейм сюда. Без маршрута открывать нечего.
definePageMeta({ layout: 'portal' })

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

    section.value = resolveSettingsSection(route.query.section)
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
    <B24DashboardGroup
      unit="px"
      storage="local"
    >
      <B24DashboardSidebar
        id="default"
        v-model:open="open"
        mode="slideover"
        resizable
        class="border-e"
      >
        <template #header>
          <ProseH2 class="mb-0 text-5.5 font-semibold text-(--ui-color-base-1)">
            Настройки
          </ProseH2>
        </template>

        <template #default="{ collapsed }">
          <B24NavigationMenu
            :collapsed="collapsed"
            :items="navItems"
            orientation="vertical"
            popover
          />
        </template>
      </B24DashboardSidebar>
      <!-- ⚠ `overflow-y-visible` ГАСИТ `overflow-y-auto` из темы панели, и это не вкусовщина (#530).
         Внутренней прокрутки этот класс всё равно не давал: корень панели — `min-h-svh` без
         потолка, поэтому тело никогда не переполняется. Замерено: высота тела равна высоте его
         содержимого (1839 = 1839) при документе в 1897, то есть прокручивается ДОКУМЕНТ.
         Вреда от мёртвого класса было бы ноль, если бы не одно: он создавал СКРОЛЛПОРТ, к
         которому привязывался `sticky` полосы разделов, — а раз этот скроллпорт не
         прокручивается, липнуть было не к чему, и полоса уезжала вместе со страницей (замерено:
         после прокрутки на 1000 px её верх оказывался на −816). Погасив его, отдаём роль
         скроллпорта документу — и полоса действительно остаётся на экране.
         ⚠ Альтернатива «прижать корень к `h-svh`, чтобы тело прокручивалось само» отвергнута: в
         портале высоту фрейма задаёт `fitWindow`, и приложение ростом ровно в один экран получило
         бы вторую прокрутку внутри чужой. -->
      <B24DashboardPanel
        id="settings"
        :b24ui="{ body: 'overflow-y-visible' }"
      >
        <template #header>
          <B24DashboardNavbar
            :toggle="false"
            :b24ui="{ root: 'ps-4' }"
            :title=" currentSection?.label || 'Важные параметры'"
          />
          <!-- ⚠ `accent="default"`, а не `less`: замерено — `less` на 11 px даёт 3.07:1 в
                 светлой теме при пороге 4.5 (docs/PAGE_GUIDE.md §9), то есть самым нечитаемым на
                 экране оказывалось единственное объяснение, что этот раздел делает. -->
          <ProseP
            accent="default"
            class="mb-6 shrink-0 flex items-center justify-between pe-4 lg:ps-4 lg:pe-4 gap-1.5 ps-4"
            data-testid="section-hint"
          >
            {{ currentSection?.hint }}
          </ProseP>
        </template>

        <template #body>
          <ClientOnly>
            <!-- Форма ВСЕГДА эмитит `close` по Save/Cancel (своего пропа для этого у неё нет);
               что это значит — решает страница: слайдер сворачиваем, иначе уводим на `/app`. -->
            <!-- Обёртка, а не класс на самой форме: у `SettingsForm` НЕСКОЛЬКО корневых узлов
               (экраны «проверяем доступ» / «только администратору» / «загрузка» / сама форма),
               и атрибуты на такой компонент не наследуются никуда — класс молча пропадал,
               а вместе с ним и высота, по которой центрируются эти экраны. -->
            <div class="flex min-h-full flex-1 flex-col">
              <SettingsForm
                :section="section"
                :currentSection="currentSection"
                @close="close"
              />
            </div>
            <template #fallback>
              <div class="flex min-h-full flex-1 flex-col">
                <!-- @todo Добавить собранный через несколько B24Skeleton заглушку -->
                <B24Skeleton class="w-4 h-2" />
              </div>
            </template>
          </ClientOnly>
        </template>
      </B24DashboardPanel>
    </B24DashboardGroup>
  </InPortalGate>
</template>
