<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useChatSettings } from '~/composables/useChatSettings'
import {
  DEFAULT_SETTINGS_SECTION,
  resolveSettingsSection,
  SETTINGS_SECTIONS,
  showsChatPreview,
  type SettingsSectionId
} from '~/utils/settingsSections'
import LoaderWaitIcon from '@bitrix24/b24icons-vue/animated/LoaderWaitIcon'
import SignIcon from '@bitrix24/b24icons-vue/main/SignIcon'

// Форма настроек приложения: навигация по разделам + активный раздел + общие Save/Cancel.
//
// ⚠ Раньше это был один аккордеон, и он ПРЯТАЛ настройки: что можно настроить, было видно только
// по заголовкам секций, а до кнопки сохранения на длинной форме надо было прокрутить экран
// целиком (#530). Тем же путём прошёл соседний `ai-price-import`.
const emit = defineEmits<{ close: [] }>()

const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
const cs = useChatSettings()
const { settings, enabled, saving, loaded, error } = cs
// Исход сохранения — тостом, а не строкой в подвале формы (см. `saveAndClose`).
const toast = useToast()

// Gate state: `adminChecked` flips only after init resolves + checkAdmin runs, so
// the form is never rendered to an unverified (possibly non-admin) user.
const adminChecked = ref(false)
const blocked = computed(() => inPortal.value && !isAdmin.value)

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
const navItems = computed(() =>
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

/**
 * Подкрутить активный пункт в зону видимости.
 *
 * ⚠ Нужно ровно на узком экране и ровно для прихода ИЗВНЕ: полоса шириной 1038 px в 375 показывает
 * два пункта из шести, поэтому ссылка вида `?section=recognition` (а её даёт и экран готовности, и
 * письмо) открывала правильный раздел при полосе, где не подсвечено НИЧЕГО — то есть выглядела как
 * «ничего не выбрано». Клик по пункту в подкрутке не нуждается, но и не страдает от неё.
 *
 * ⚠ `block: 'nearest'` обязателен: без него браузер вертикально прокручивает страницу к полосе,
 * а нам нужна только горизонтальная доводка.
 */
const navEl = ref<HTMLElement | null>(null)
watch(section, async () => {
  await nextTick()
  navEl.value?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
})

onMounted(async () => {
  // Await init AND a tick: useB24 flips its ready flag on nextTick after the frame
  // handshake, so isInit() lags an un-awaited init(). Without this the gate reads
  // "not in portal" and fails open (form shown to a non-admin) on a cold load.
  await useB24().init()
  await nextTick()
  checkAdmin()
  adminChecked.value = true
  section.value = resolveSettingsSection(route.query.section)
  if (blocked.value) return // non-admin: don't load or expose the form
  if (!loaded.value) await cs.load()
})

// Explicit Save (starter Save/Cancel pattern — no autosave). cs.save() persists AND
// notifies other open instances (pull `reload.options`). On success, close the screen
// if embedded in one; keep the form open on error so the admin can retry.
async function saveAndClose(): Promise<void> {
  if (!enabled.value) return
  await cs.save()
  if (error.value) {
    // Ошибку показываем ТОСТОМ и форму не закрываем: строка под кнопками жила в самом низу
    // длинной формы, то есть человек, правивший поле наверху, узнавал о неудаче, только если
    // догадывался прокрутить обратно.
    toast.add({
      title: 'Не удалось сохранить настройки',
      description: error.value,
      color: 'air-primary-alert'
    })
    return
  }
  toast.add({ title: 'Настройки сохранены', color: 'air-primary-success' })
  emit('close')
}

// Cancel = discard: re-fetch the server copy, then close. The re-fetch matters because every
// mount shares this SAME JS instance (the singleton settings), so without a reload the unsaved
// edits would still be in `settings` and reappear the next time the screen is opened.
//
// ⚠ Поля-списки («Исключения») пересеваются САМИ — и на монтировании, и на возвращении из кэша
// (`onActivated`). Именно из кэша, а не с нуля: под `KeepAlive` уход на соседний раздел ничего не
// размонтирует, и рассуждение «вернётся — посеется заново» было бы неверным (замерено). Без
// пересева отменённый текст оставался бы в поле и возвращался в настройки первым же нажатием
// клавиши.
async function cancel(): Promise<void> {
  if (enabled.value) {
    await cs.load()
  }
  emit('close')
}
</script>

<template>
  <!-- Withhold everything until the admin check resolves (no fail-open flash). -->
  <div
    v-if="!adminChecked"
    class="mx-auto flex min-h-full w-full max-w-lg flex-1 flex-col items-center justify-center gap-3 px-4 text-center"
    data-testid="checking"
  >
    <LoaderWaitIcon
      class="size-12"
      aria-hidden="true"
    />
    <ProseP
      accent="less"
      small
    >
      Проверяем доступ…
    </ProseP>
  </div>

  <!-- Non-admin in the portal: warning only, no settings. -->
  <div
    v-else-if="blocked"
    class="mx-auto flex min-h-full w-full max-w-lg flex-1 flex-col items-center justify-center gap-3 px-4 text-center"
    data-testid="admin-gate"
  >
    <!-- h2, а не h3: над формой стоит `h1` навбара страницы, и уровень не должен перескакивать. -->
    <ProseH2 class="mb-0">
      Настройки доступны только администратору
    </ProseH2>
    <ProseP accent="less">
      Обратитесь к администратору вашего Bitrix24 — изменять параметры импорта и уведомлений может только он.
    </ProseP>
  </div>

  <!-- In portal, settings still loading. -->
  <div
    v-else-if="enabled && !loaded"
    class="mx-auto flex min-h-full w-full max-w-lg flex-1 flex-col items-center justify-center gap-3 px-4 text-center"
    data-testid="loading"
  >
    <LoaderWaitIcon
      class="size-12"
      aria-hidden="true"
    />
    <ProseP
      accent="less"
      small
    >
      Загрузка настроек…
    </ProseP>
  </div>

  <template v-else>
    <B24Form
      :state="settings"
      class="space-y-4"
    >
      <B24Alert
        v-if="!enabled"
        :icon="SignIcon"
        color="air-secondary-accent-2"
        title="Режим предпросмотра."
        description="Работа формы возможна только в Bitrix24."
      />

      <!-- Полоса разделов. `B24DashboardToolbar` сам прокручивается по горизонтали: на телефоне
           шесть пунктов в строку не помещаются, а перенос вторым рядом съедал бы пол-экрана. -->
      <!-- ⚠ Без `-mx-4`: отрицательные поля выносили полосу на 16 px за правый край экрана, и
           подкрутка активного пункта «до ближайшего края» ставила его ровно под этот вынос — то
           есть на узком экране активный раздел оставался подрезанным (замерено: правый край на
           391 при экране 375). Полоса и так во всю ширину: на мобильном у тела панели отступов
           нет вовсе (`sm:p-4` в теме), а на широком экране рамка в 16 px совпадает с остальным
           содержимым. -->
      <B24DashboardToolbar class="sticky top-0 z-10 base-mode bg-default">
        <template #left>
          <!-- ⚠ Ref висит на ОБЁРТКЕ, а не на самом меню: `ref` на компоненте даёт его
               экземпляр, а не узел DOM, и `querySelector` по нему упал бы в рантайме, оставаясь
               зелёным при проверке типов. -->
          <div ref="navEl">
            <B24NavigationMenu
              :items="navItems"
              orientation="horizontal"
              data-testid="settings-nav"
            />
          </div>
        </template>
      </B24DashboardToolbar>

      <div class="flex flex-col lg:flex-row items-start justify-between gap-4">
        <div class="w-full min-w-0 space-y-3">
          <div>
            <!-- h2, а не h3: над формой стоит `h1` навбара страницы. -->
            <ProseH2
              class="mb-0"
              data-testid="section-title"
            >
              {{ currentSection?.label }}
            </ProseH2>
            <!-- ⚠ `accent="default"`, а не `less`: замерено — `less` на 11 px даёт 3.07:1 в
                 светлой теме при пороге 4.5 (docs/PAGE_GUIDE.md §9), то есть самым нечитаемым на
                 экране оказывалось единственное объяснение, что этот раздел делает. -->
            <ProseP
              accent="default"
              small
              class="mb-0"
              data-testid="section-hint"
            >
              {{ currentSection?.hint }}
            </ProseP>
          </div>

          <!-- ⚠ `KeepAlive` здесь несущий, а не «для скорости»: раздел «Подключение банка» при
               монтировании сверяет счета, а сверка ходит В БАНК. Без кэша каждое переключение
               вкладки туда-обратно било бы по лимитам банка запросом, которого никто не просил.
               Кэшировать `KeepAlive` умеет только КОМПОНЕНТЫ — отсюда и вынос разделов в файлы. -->
          <KeepAlive>
            <SettingsSectionBank v-if="section === 'bank'" />
            <SettingsSectionChats v-else-if="section === 'chats'" />
            <SettingsSectionDistribution v-else-if="section === 'distribution'" />
            <SettingsSectionExclusions v-else-if="section === 'exclusions'" />
            <SettingsSectionAutoDistribute v-else-if="section === 'auto'" />
            <!-- ⚠ `:disabled` не передаём: до этой ветки не-админ не доходит вовсе (выше стоит
                 `v-else-if="blocked"` со своим экраном), и проп был бы всегда `false` — то есть
                 обещал бы защиту, которой в этом месте не существует. -->
            <SettingsSectionRecognition v-else-if="section === 'recognition'" />
            <SettingsSectionCleanup v-else-if="section === 'cleanup'" />
          </KeepAlive>
        </div>

        <div class="w-full lg:max-w-105 shrink-0 flex flex-col gap-4">
          <!-- Готовность — на КАЖДОМ разделе (#530): она отвечает на вопрос «что ещё не
               настроено», и он одинаково уместен, в каком бы разделе человек ни находился. -->
          <!-- Красная строка готовности ведёт прямо в свой раздел: от «что не так» до «где это
               чинить» — один клик. Без этого разбор `?section=` был бы возможностью, до которой
               из приложения не добраться. -->
          <SetupReadinessCard @open-section="section = $event" />

          <!-- А предпросмотр — только там, где он про ЭТИ правила. Рядом с картой распознавания
               он отвечал бы на вопрос, которого на экране не задавали. -->
          <SettingsChatPreviewCard
            v-if="showsChatPreview(section)"
            class="lg:sticky lg:top-4"
          />
        </div>
      </div>

      <!-- Отзыв о САМИХ настройках (#528, 3.4): «не работает вот эта настройка» / «нужна вот
           такая». Экран готовности рядом собирает отзыв про постановку задачи, здесь — про
           конкретные поля формы; ставим над панелью Save/Cancel, чтобы её не перекрывать. -->
      <!-- ⚠ В `place` едет РАЗДЕЛ, а не просто «настройки»: иначе отзыв «не работает вот эта
           настройка» приходит без указания, в каком из шести экранов человек стоял, — а именно
           это и надо знать, чтобы понять, о чём речь. -->
      <FeedbackWidget :place="`настройки: ${currentSection?.label ?? ''}`" />

      <!-- ⚠ Распорка под панелью Save/Cancel — ОТДЕЛЬНЫМ узлом, а не классом `pb-24` на виджете
           отзывов. Виджет рендерится только при настроенном канале (`GITHUB_FEEDBACK_*`,
           fail-closed), и вместе с ним исчезала распорка: замерено — панель накрывала последние
           41 px содержимого, то есть на «Карте распознавания» подрезалось поле ввода. -->
      <div
        v-if="enabled"
        class="h-24"
        aria-hidden="true"
      />

      <!-- Explicit Save/Cancel (no autosave). Save persists + notifies other instances.
           ⚠ Кнопки ОБЩИЕ на все разделы, а не свои у каждого: настройки — один блоб в
           `app.option`, и сохранение «только этого раздела» обещало бы избирательность, которой
           на сервере нет.
           ⚠ Панель стоит в конце формы, а НЕ приклеена к экрану — замерено: её `offsetParent` это
           корень панели, высота которого равна высоте содержимого, поэтому `absolute bottom` кладёт
           её в самый низ страницы. Первая редакция этого комментария утверждала обратное. До неё
           по-прежнему надо прокрутить раздел — но раздел, а не всю форму из шести секций, и в этом
           и состоит выигрыш #530. Настоящее приклеивание требует высоты в один экран у корня
           панели, а в портале высоту фрейма задаёт `fitWindow` — это отдельная работа. -->
      <div
        v-if="enabled"
        class="absolute inset-x-0 bottom-1.5 base-mode bg-default flex items-center justify-center gap-2.5 border-t border-t-(--ui-color-divider-less) shadow-top-md py-3.25 px-3.25"
      >
        <B24Button
          size="lg"
          color="air-primary"
          :loading="saving"
          :disabled="saving || !isAdmin"
          label="Сохранить"
          data-testid="settings-save"
          @click="saveAndClose"
        />

        <B24Button
          size="sm"
          color="air-tertiary"
          :disabled="saving"
          label="Отмена"
          :normal-case="false"
          data-testid="settings-cancel"
          @click="cancel"
        />
      </div>
    </B24Form>
  </template>
</template>
