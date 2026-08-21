<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
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

// Пункты навигации: активный подсвечен, клик переключает раздел. `value` обязателен — b24ui иначе
// нумерует пункты по индексу, и вставка раздела в середину сдвинула бы подсветку.
const navItems = computed(() =>
  SETTINGS_SECTIONS.map(s => ({
    label: s.label,
    value: s.id,
    active: section.value === s.id,
    onSelect: (e: Event) => {
      e.preventDefault()
      section.value = s.id
    }
  }))
)
const currentSection = computed(() => SETTINGS_SECTIONS.find(s => s.id === section.value))

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
// ⚠ Поля-списки («Исключения») сеются при монтировании СВОЕГО раздела, поэтому отдельного
// пересева здесь больше не нужно: раздел, которого нет на экране, размонтирован, а вернувшись,
// он посеется уже из перечитанных настроек.
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
      <B24DashboardToolbar class="-mx-4 px-4 sticky top-0 z-10 base-mode bg-default">
        <template #left>
          <B24NavigationMenu
            :items="navItems"
            orientation="horizontal"
            data-testid="settings-nav"
          />
        </template>
      </B24DashboardToolbar>

      <div class="flex flex-col lg:flex-row items-start justify-between gap-4">
        <div class="w-full min-w-0 space-y-3">
          <div>
            <!-- h2, а не h3: над формой стоит `h1` навбара страницы. -->
            <ProseH2 class="mb-0">
              {{ currentSection?.label }}
            </ProseH2>
            <ProseP
              accent="less"
              small
              class="mb-0"
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
            <SettingsSectionRecognition
              v-else-if="section === 'recognition'"
              :disabled="blocked"
            />
          </KeepAlive>
        </div>

        <div class="w-full lg:max-w-105 shrink-0 flex flex-col gap-4">
          <!-- Готовность — на КАЖДОМ разделе (#530): она отвечает на вопрос «что ещё не
               настроено», и он одинаково уместен, в каком бы разделе человек ни находился. -->
          <SetupReadinessCard />

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
      <FeedbackWidget
        place="настройки"
        class="pb-24"
      />

      <!-- Explicit Save/Cancel (no autosave). Save persists + notifies other instances.
           ⚠ Кнопки ОБЩИЕ на все разделы, а не свои у каждого: настройки — один блоб в
           `app.option`, и сохранение «только этого раздела» обещало бы избирательность, которой
           на сервере нет. Панель закреплена внизу, поэтому до неё больше не надо прокручивать
           форму целиком — ровно та жалоба, с которой #530 и начался. -->
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
