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

// Открыт ли МОБИЛЬНЫЙ оверлей со списком разделов.
//
// ⚠ `open` управляет НЕ десктопным сайдбаром (тот рендерится всегда, `hidden lg:flex`), а
// оверлеем `lg:hidden`. И он МОДАЛЬНЫЙ: при `true` reka вешает `aria-hidden` на остальную
// страницу, запирает фокус и ставит `pointer-events: none` на `body`. На широком экране сам
// оверлей при этом невидим — то есть `open = true` давал невидимую модалку, которая гасит клики
// по всему экрану настроек до первого «клика в никуда». Найдено ревью до выката; прежний
// комментарий («закрытый старт прятал бы навигацию») описывал не то, что делает проп.
const open = ref(false)

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
  } catch (e) {
    log.warning('рукопожатие с порталом не состоялось', { error: String(e) })
  }
  // ⚠ Раздел из адреса разбираем ВНЕ try: он не зависит ни от портала, ни от `setTitle`. Внутри
  // блока отказ `setTitle` глотал и его — и глубокая ссылка (её даёт экран готовности) молча
  // открывала раздел по умолчанию.
  section.value = resolveSettingsSection(route.query.section)
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
          <!-- ⚠ `data-testid` держит проверку «до каждого раздела можно дойти кликом»: полоса
               разделов — единственный путь к половине настроек, и её неработающий пункт означает
               недостижимый экран. -->
          <B24NavigationMenu
            :collapsed="collapsed"
            :items="navItems"
            orientation="vertical"
            popover
            data-testid="settings-nav"
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
          <!-- ⚠ Тумблер меню ОБЯЗАТЕЛЕН: ниже `lg` список разделов живёт только в оверлее, а
               открыть его больше нечем — гамбургер рендерится именно навбаром. С `:toggle="false"`
               на узком экране (а слайдер портала бывает и 640 px) разделы становились недостижимы
               навсегда. Найдено ревью до выката. -->
          <B24DashboardNavbar
            :b24ui="{ root: 'ps-4' }"
            :title="currentSection?.label || 'Важные параметры'"
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
              <!-- ⚠ `v-model:section`, а не односторонний проп: экран готовности внутри формы
                   переключает раздел («перейти и починить»), и без обратной связи эти ссылки
                   молча перестают работать. -->
              <SettingsForm
                v-model:section="section"
                @close="close"
              />
            </div>
            <!-- Заглушка на время, пока форма не смонтировалась на клиенте.
                 ⚠ Она повторяет РАСКЛАДКУ раздела, а не рисует одну полоску: страница
                 пререндеренная, поэтому этот кадр видно на каждом открытии слайдера, и заглушка
                 не в форме содержимого даёт скачок вёрстки в момент подмены. Пропорции взяты с
                 реального раздела — карточка настроек слева и экран готовности справа.
                 ⚠ `aria-hidden` + `aria-busy` на обёртке: скринридеру читать нечего, но состояние
                 «идёт загрузка» сообщить надо, иначе экран для него просто пуст. -->
            <template #fallback>
              <div
                class="flex min-h-full flex-1 flex-col gap-4"
                aria-busy="true"
                data-testid="settings-skeleton"
              >
                <div
                  class="flex flex-col lg:flex-row items-start gap-4"
                  aria-hidden="true"
                >
                  <div class="w-full min-w-0 space-y-3">
                    <B24Skeleton class="h-7 w-2/5" />
                    <B24Skeleton class="h-4 w-3/5" />
                    <B24Skeleton class="h-40 w-full" />
                    <B24Skeleton class="h-24 w-full" />
                  </div>
                  <div class="w-full lg:w-80 space-y-3">
                    <B24Skeleton class="h-5 w-1/2" />
                    <B24Skeleton class="h-32 w-full" />
                  </div>
                </div>
              </div>
            </template>
          </ClientOnly>
        </template>
      </B24DashboardPanel>
    </B24DashboardGroup>
  </InPortalGate>
</template>
