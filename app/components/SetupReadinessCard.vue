<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSetupStatus } from '~/composables/useSetupStatus'
import { useChatSettings } from '~/composables/useChatSettings'
import { buildReadiness, isFullyReady } from '~/utils/setupReadiness'
import { formatRelativeTime } from '~/utils/importStatus'
import LoaderWaitIcon from '@bitrix24/b24icons-vue/animated/LoaderWaitIcon'
import CheckIcon from '@bitrix24/b24icons-vue/main/CheckIcon'
import Cross30Icon from '@bitrix24/b24icons-vue/actions/Cross30Icon'
import AlertIcon from '@bitrix24/b24icons-vue/outline/AlertIcon'

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
  return ready.value ? 'всё настроено' : `осталось: ${pending.value}`
})
const pending = computed(() => items.value.filter(i => !i.ok).length)

// «5 минут назад» — recomputed against a ticking clock, not a `Date.now()` frozen inside a computed
// (a slideover left open would otherwise keep claiming «2 минуты назад» forever).
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
    title="Готовность к работе"
    :description="description"
    data-testid="setup-readiness"
    class="w-full"
  >
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

    <template v-else>
      <B24Alert
        v-if="setup.error.value"
        role="alert"
        aria-live="assertive"
        color="air-primary-alert"
        :icon="AlertIcon"
        title="Проблемы."
        :description="setup.error.value || 'Смотри логи в консоле.'"
        class="mb-3"
        data-testid="readiness-error"
      />

      <ul class="space-y-3">
        <li
          v-for="i in items"
          :key="i.key"
          class="flex gap-2"
          :data-testid="`readiness-${i.key}`"
        >
          <!-- Never colour alone: the ✓/! glyph and the wording carry the state too. -->
          <CheckIcon
            v-if="i.ok"
            class="mt-1.5 text-(--ui-color-accent-main-success) size-5"
          />
          <Cross30Icon
            v-else
            class="mt-1 text-(--ui-color-accent-main-warning) size-5"
          />
          <div class="min-w-0">
            <div class="flex flex-row flex-nowrap items-start justify-start gap-2">
              <ProseP
                accent="default"
                class="mb-0"
              >
                {{ i.title }}
              </ProseP>
              <ProseP
                accent="less"
                small
                class="mb-0 mt-1.5"
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
          </div>
        </li>
      </ul>
    </template>

    <!-- Расписание — только КОГДА проверка завершена: до ответа сервера числа в нём выдуманные. -->
    <template
      v-if="setup.loaded.value"
      #footer
    >
      <!-- Schedule (#405): the question «а когда оно само сходит в банк?» had no answer anywhere. -->
      <!-- «Последний ИМПОРТ», не «опрос»: отметку ставит любой прогон crm-sync, включая ручную
           загрузку файла — иначе портал без единого подключения читал бы «последний опрос». -->
      <ProseP
        v-if="setup.status.value.pollEnabled"
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
        v-else
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
