<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSetupStatus } from '~/composables/useSetupStatus'
import { useChatSettings } from '~/composables/useChatSettings'
import { buildReadiness, isFullyReady } from '~/utils/setupReadiness'
import { formatRelativeTime } from '~/utils/importStatus'
import LoaderWaitIcon from '@bitrix24/b24icons-vue/animated/LoaderWaitIcon'
import CheckIcon from '@bitrix24/b24icons-vue/main/CheckIcon'
import Cross30Icon from '@bitrix24/b24icons-vue/actions/Cross30Icon'
import { SETTINGS_SECTIONS, sectionForReadiness, type SettingsSectionId } from '~/utils/settingsSections'
import AlertIcon from '@bitrix24/b24icons-vue/outline/AlertIcon'

// ⚠ Карточка не переключает раздел САМА: она живёт и на экране настроек, и (в будущем) где угодно
// ещё, а знание «какой раздел сейчас открыт» принадлежит форме. Поэтому — событие наружу.
const emit = defineEmits<{ openSection: [SettingsSectionId] }>()

/** Название раздела для подписи кнопки: свою копию названий здесь заводить нельзя — разъедется. */
function sectionLabel(key: string): string {
  const id = sectionForReadiness(key)
  return SETTINGS_SECTIONS.find(s => s.id === id)?.label ?? ''
}

// «Что настроено, а что нет» — the first thing in the settings (#409/#405).
//
// Before this, a half-configured portal looked completely normal: the bank card, the chat picker and
// the smart-process button each knew their own state and none of them said whether the app would
// actually do anything. The schedule was nowhere at all, so «почему ничего не приходит?» had no
// answer on screen.
//
// Composition is deliberate: portal settings come from the shared singleton the form already uses,
// server facts from /api/setup-status. Joining them here (not on the server) keeps one source of
// truth for settings — a server copy could disagree with the form the admin is editing.

const setup = useSetupStatus()
const chatSettings = useChatSettings()

/** Мы внутри портала? Вне его серверных фактов нет вовсе. */
const inFrame = computed(() => setup.inFrame.value)

const items = computed(() => buildReadiness({
  settings: chatSettings.settings,
  connectedAccounts: setup.status.value.connectedAccounts,
  pendingAccounts: setup.status.value.pendingAccounts,
  myCompany: setup.status.value.myCompany,
  pollEnabled: setup.status.value.pollEnabled,
  pollIntervalMin: setup.status.value.pollIntervalMin,
  lastRunMs: setup.status.value.lastRunMs
}))

const ready = computed(() => isFullyReady(items.value))
/** Подпись карточки. В computed, а не тернарником в шаблоне: три состояния в одну строку атрибута
 *  не читаются, а вычислять их надо в одном месте — подпись и содержимое обязаны говорить одно. */
const description = computed(() => {
  // ⚠ Вне портала подписи НЕТ. Данных о портале там ниоткуда не взять, а `buildReadiness` считает
  // по дефолтам — и карточка уверенно сообщала «осталось: 6» о портале, который никто не
  // спрашивал. Уверенное число, посчитанное из пустоты, хуже отсутствующего.
  if (!inFrame.value) return undefined
  if (!setup.loaded.value) return 'проверяем…'
  // Тот же запрет и для СБОЯ чтения: `buildReadiness` посчитает по дефолтам (ноль счетов, опрос
  // выключен), и «осталось: 6» прозвучит уверенным диагнозом настроенному порталу, у которого мы
  // просто не смогли спросить.
  if (setup.error.value) return undefined
  return ready.value ? 'всё настроено' : `осталось: ${pending.value}`
})
const pending = computed(() => items.value.filter(i => !i.ok).length)

// «5 минут назад» — recomputed against a ticking clock, not a `Date.now()` frozen inside a computed
// (a screen left open would otherwise keep claiming «2 минуты назад» forever).
const nowMs = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const lastRun = computed(() => {
  const ms = setup.status.value.lastRunMs
  return ms === null ? '' : formatRelativeTime(new Date(ms).toISOString(), nowMs.value)
})

/** Re-read the server half. Bound to window focus so returning from the bank tab (a top-level
 *  redirect that never notifies us) doesn't leave the checklist claiming «нет подключений» about
 *  the account the admin just connected. */
function refresh() {
  void setup.load()
}

onMounted(() => {
  void setup.load()
  // Chat settings are NOT loaded here: the parent form already loaded them, and useChatSettings.load()
  // is NOT idempotent — a second call would re-fetch and `Object.assign` the server copy over
  // whatever the admin has typed since, silently discarding edits.
  clock = setInterval(() => (nowMs.value = Date.now()), 30_000)
  if (import.meta.client) window.addEventListener('focus', refresh)
})

onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
  if (import.meta.client) window.removeEventListener('focus', refresh)
})
</script>

<template>
  <B24Card
    :description="description"
    data-testid="setup-readiness"
    class="w-full"
  >
    <!-- Заголовок слотом, а не пропом: проп `title` рендерится обычным `div`, и единственный
         заголовок блока выпадал из навигации по заголовкам у скринридера. -->
    <template #title>
      <div class="flex items-baseline gap-3 flex-wrap">
        <h2 class="text-lg font-semibold">
          Готовность к работе
        </h2>
        <!-- ⚠ Экран готовности перечисляет, ЧТО не настроено, но не отвечает «а что делать, если
             всё зелёное, а платежей нет». Ссылка ведёт ровно в этот раздел справки. -->
        <HelpLink anchor="not-working" />
      </div>
    </template>

    <B24Alert
      v-if="!inFrame"
      color="air-primary"
      description="Готовность видна внутри портала Bitrix24. Здесь — предпросмотр."
      data-testid="readiness-preview"
    />

    <div
      v-else-if="!setup.loaded.value"
      class="mx-auto flex min-h-full max-w-lg flex-col items-center justify-center gap-3 px-4 text-center"
      data-testid="loading"
      role="status"
      aria-live="polite"
    >
      <LoaderWaitIcon
        class="size-12"
        aria-hidden="true"
      />
      <ProseP
        accent="less"
        small
      >
        Проверяем настройку…
      </ProseP>
    </div>

    <!-- Не удалось спросить сервер — показываем ТОЛЬКО это. Ниже чек-лист считался бы по
         дефолтам, то есть настроенному порталу рисовались бы красные «Банк подключён» и
         «Автоопрос включён» — состояние, которого мы не читали. -->
    <B24Alert
      v-else-if="setup.error.value && !setup.loadedOk.value"
      role="alert"
      aria-live="assertive"
      color="air-primary-alert"
      :icon="AlertIcon"
      title="Не удалось прочитать состояние настройки"
      :description="`${setup.error.value} Попробуйте обновить страницу — если не поможет, напишите нам через форму обратной связи ниже.`"
      data-testid="readiness-error"
    />

    <template v-else>
      <ul class="space-y-3">
        <li
          v-for="i in items"
          :key="i.key"
          class="flex gap-2"
          :data-testid="`readiness-${i.key}`"
        >
          <!-- Never colour alone: the ✓/! glyph and the wording carry the state too. -->
          <!-- Состояние озвучивает `sr-only`-подпись ниже, поэтому сама иконка для
               скринридера — шум: без `aria-hidden` строка читалась бы дважды. -->
          <CheckIcon
            v-if="i.ok"
            aria-hidden="true"
            class="mt-1 text-(--ui-color-green-95) dark:text-(--ui-color-accent-main-success) size-5"
          />
          <Cross30Icon
            v-else
            aria-hidden="true"
            class="mt-1 text-(--ui-color-red-80) dark:text-(--ui-color-red-50) size-5"
          />
          <div class="min-w-0">
            <!-- `flex-wrap`: деталь строки — это номер счёта или название чата, на 375 px
                 в одну строку с заголовком они не помещаются, а `nowrap` распирал бы блок. -->
            <div class="flex flex-row flex-wrap items-baseline justify-start gap-x-2">
              <ProseP
                accent="default"
                class="mb-0"
              >
                {{ i.title }}
              </ProseP>
              <ProseP
                accent="less"
                small
                class="mb-0 min-w-0"
              >
                — {{ i.detail }}
              </ProseP>
              <span class="sr-only">{{ i.ok ? '(настроено)' : '(не настроено)' }}</span>
            </div>
            <ProseP
              v-if="i.hint"
              small
              accent="less"
            >
              {{ i.hint }}
            </ProseP>
            <!-- ⚠ Ссылка ТОЛЬКО у непорядка и только там, где раздел вообще есть (#530). Строка
                 «Моя компания» чинится в карточке компании в CRM, а не в настройках приложения —
                 кнопка «Перейти к настройке» там увела бы человека не туда. У зелёной строки
                 переходить незачем: настраивать нечего. -->
            <B24Button
              v-if="!i.ok && sectionForReadiness(i.key)"
              size="xs"
              color="air-tertiary"
              :label="`Перейти: ${sectionLabel(i.key)}`"
              :normal-case="false"
              class="mt-1"
              :data-testid="`readiness-goto-${i.key}`"
              @click="emit('openSection', sectionForReadiness(i.key)!)"
            />
          </div>
        </li>
      </ul>
    </template>

    <!-- ⚠ Расписание — только когда данные НАСТОЯЩИЕ. До ответа сервера числа в нём выдуманные,
         а при сбое чтения они выдуманные ровно так же: «Автоматический опрос выключен» — это
         `pollEnabled:false` из дефолтов, то есть уверенная неправда настроенному порталу. Тот же
         запрет, что для чек-листа выше. Отзыв при этом остаётся: на экране ошибки текст алерта
         сам отсылает «напишите нам через форму обратной связи ниже». -->
    <template #footer>
      <!-- Schedule (#405): the question «а когда оно само сходит в банк?» had no answer anywhere. -->
      <!-- «Последний ИМПОРТ», не «опрос»: отметку ставит любой прогон crm-sync, включая ручную
           загрузку файла — иначе портал без единого подключения читал бы «последний опрос». -->
      <ProseP
        v-if="setup.loadedOk.value && setup.status.value.pollEnabled"
        accent="accent"
      >
        Опрос банков каждые {{ setup.status.value.pollIntervalMin }} мин.
        <template v-if="lastRun">
          Последний импорт: {{ lastRun }}.
        </template>
        <template v-else>
          Импортов ещё не было.
        </template>
      </ProseP>
      <ProseP
        v-else-if="setup.loadedOk.value"
        small
        accent="less"
      >
        Автоматический опрос банков выключен, выписка не забирается сама. Ручная загрузка файла работает всегда.
      </ProseP>

      <!-- «Не понимаю, чего от меня хотят» (#499). Экран готовности перечисляет требования — и
           это единственное место, где человек может застрять НЕ на платеже, а на самой
           постановке задачи. Отзыв отсюда несёт только место: никаких данных клиента здесь нет. -->
      <FeedbackWidget
        place="экран готовности"
        class="mt-3"
      />
    </template>
  </B24Card>
</template>
