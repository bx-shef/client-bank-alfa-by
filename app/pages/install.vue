<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useB24 } from '~/composables/useB24'
import { B24_ALL_BOUND_EVENTS, B24_EVENT_HANDLER_PATH, B24_PAYMENT_TRIGGER } from '~/config/b24'
import { buildEventBindCalls, isBindableHandlerUrl, type EventBinding } from '~/utils/b24EventBind'
import { buildTriggerRegisterCall } from '~/utils/b24TriggerRegister'
import { installVerdict, type BackendState } from '~/utils/installVerdict'
import { checkBackendKnowsPortal } from '~/composables/useBackendInstallCheck'
import { LANDING_TITLE, pageTitle } from '~/utils/landing'

definePageMeta({ layout: 'clear' })

const b24Instance = useB24()
const isUseB24 = computed<boolean>(() => b24Instance.isInit())
const requiredScopes = b24Instance.getRequiredRights()

// Public URL the app is served from. In prod it comes from NUXT_PUBLIC_SITE_URL
// (build-arg); in dev it isn't known ahead of time, so derive it from the install
// URL by stripping the trailing `/install`. The backend events endpoint is same
// origin (`/api/*` proxied to backend), so the handler URL is appUrl + the path.
const stripTrailing = (u: string) => u.replace(/\/+$/, '')
const config = useRuntimeConfig()
const configuredSiteUrl = stripTrailing((config.public.siteUrl as string) || '')
const isDev = import.meta.env.DEV
const appUrl = isDev && typeof window !== 'undefined'
  ? stripTrailing(`${window.location.origin}${window.location.pathname.replace(/\/install\/?$/, '')}`)
  : configuredSiteUrl
const eventHandlerUrl = computed(() => `${appUrl}${B24_EVENT_HANDLER_PATH}`)

useHead({ title: pageTitle('Установка') })

const progressColor = ref<'air-primary' | 'air-primary-success' | 'air-primary-warning' | 'air-primary-alert'>('air-primary')
const progressValue = ref<null | number>(null)
// Non-empty while the last install attempt failed — drives the retry UI.
const installError = ref('')
// True while an install attempt is in flight — guards the Retry button.
const isRunning = ref(false)
const caption = ref('Инициализация…')
/** Установка дошла до installFinish — только тогда вердикт вообще имеет смысл. */
const finished = ref(false)
/** Видит ли backend наш портал (#413). До проверки — 'unknown': молчим, а не пугаем. */
const backendState = ref<BackendState>('unknown')
/** Идёт проверка серверной части. Пока идёт — вердикт НЕ показываем: иначе на секунды загорелось
 *  бы зелёное «Приложение установлено», которое потом схлопнулось бы в жёлтое. Для экрана, чья
 *  задача — доверие к вердикту, такой кадр хуже паузы. */
const checkingBackend = ref(false)
// Best-effort automation-trigger registration outcome (#79): '' = not attempted,
// 'ok' = registered, otherwise a short error string for the diagnostics panel.
const triggerRegistered = ref('')

interface InitData {
  appInfo?: { ID?: number, CODE?: string, VERSION?: string }
  scope?: string[]
  eventList?: EventBinding[]
}
const initData = ref<InitData>({})

const diagnostics = computed(() => {
  const granted = initData.value.scope ?? []
  const missing = requiredScopes.filter(s => !granted.includes(s))
  let domain = ''
  let memberId = ''
  if (isUseB24.value) {
    const auth = b24Instance.getOrThrow().auth.getAuthData()
    if (auth !== false) {
      domain = auth.domain
      memberId = auth.member_id || ''
    }
  }
  return {
    mode: isUseB24.value ? 'B24 frame' : 'Standalone (mock)',
    domain,
    // Shown on the diagnostics panel so operators can identify the portal (support/logs).
    memberId,
    targetOrigin: isUseB24.value ? b24Instance.targetOrigin() : '—',
    // Backend events handler the install script binds — surfaced so a misconfigured
    // (empty / relative) URL is obvious on the diagnostics panel.
    eventHandler: isUseB24.value ? (eventHandlerUrl.value || '—') : '—',
    appInfo: initData.value.appInfo,
    granted,
    missing,
    events: initData.value.eventList ?? [],
    // Best-effort automation-trigger registration (#79): '' hides the row.
    trigger: triggerRegistered.value
  }
})

// Вердикт установки (#410): «установилось» и «работает» — разные вещи. Раньше недовыданные права
// рисовались бейджами внутри СВЁРНУТОЙ диагностики, то есть их никто не видел, и портал спокойно
// жил с молча выключенными функциями (так и вскрылся #408).
const verdict = computed(() => installVerdict({
  finished: finished.value,
  missingScopes: diagnostics.value.missing,
  trigger: triggerRegistered.value,
  backend: backendState.value
}))
// Раскрытие «Диагностики». ОБЯЗАТЕЛЬНО обычный ref под v-model, а не computed под :model-value:
// с односторонним биндингом аккордеон становится управляемым, эмит слушать некому — и панель
// перестаёт открываться даже кликом. Идентификатор элемента — его `value` ('diag'), а не индекс.
const diagOpen = ref<string[]>([])
watch(() => verdict.value.issues.length, (n) => {
  if (n > 0) diagOpen.value = ['diag'] // есть о чём говорить — показываем сразу
}, { immediate: true })

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForB24(timeoutMs = 10000): Promise<boolean> {
  await b24Instance.init()
  const start = Date.now()
  while (!isUseB24.value && (Date.now() - start) < timeoutMs) {
    await sleep(100)
  }
  return isUseB24.value
}

/** Binds the server-event handlers to the backend endpoint: the app lifecycle events
 *  (ONAPPINSTALL/ONAPPUNINSTALL — ONAPPINSTALL carries the application_token + OAuth creds) AND
 *  the CRM deletion events (§9.2 ledger reconcile) in one batch (`B24_ALL_BOUND_EVENTS`). Must run
 *  BEFORE installFinish so the current install's ONAPPINSTALL is delivered. Idempotent: re-installs
 *  skip already-correct bindings and re-point stale ones (so this also back-fills the deletion
 *  bindings on a re-install of an app that predates them). */
async function bindEvents(): Promise<void> {
  const $b24 = b24Instance.getOrThrow()

  // A relative/empty handler URL would register a dead binding B24 could never
  // reach. Refuse rather than ship a broken portal (needs NUXT_PUBLIC_SITE_URL).
  if (!isBindableHandlerUrl(eventHandlerUrl.value)) {
    throw new Error(`Обработчик событий не абсолютный (${eventHandlerUrl.value || 'пусто'}). Задайте NUXT_PUBLIC_SITE_URL при сборке.`)
  }

  const existing = initData.value.eventList ?? []
  const { unbind, bind } = buildEventBindCalls(existing, B24_ALL_BOUND_EVENTS, eventHandlerUrl.value)

  // Best-effort cleanup of stale bindings — a missing one is fine, don't halt.
  if (unbind.length) await $b24.actions.v2.batch.make({ calls: unbind, options: { isHaltOnError: false } })

  // Bind the missing events. This is the whole point of the handler, so a failure
  // is fatal (surfaced as a retryable error) — a half-bound app never learns the token.
  if (bind.length) {
    const res = await $b24.actions.v2.batch.make({ calls: bind })
    if (!res.isSuccess) throw new Error(`event.bind не удался: ${res.getErrorMessages().join('; ')}`)
  }
}

/** Registers the app's «деньги пришли» automation trigger (#79) so a portal admin
 *  can attach it to an automation rule; the worker later fires the same CODE. Runs
 *  in the install iframe (application context — required by the method) and is
 *  BEST-EFFORT: unlike event.bind (which delivers the token), the trigger is a
 *  convenience for the auto-distribute feature, so a failure (non-admin installer,
 *  non-commercial plan, `crm.automation.*` unavailable) must NOT block the install —
 *  it is logged + surfaced in diagnostics, never thrown. `crm.automation.trigger.add`
 *  is idempotent (re-adding the same CODE just updates NAME) and can't be batched. */
async function registerTrigger(): Promise<void> {
  const call = buildTriggerRegisterCall(B24_PAYMENT_TRIGGER.code, B24_PAYMENT_TRIGGER.name)
  if (!call) return // fail-safe: never send a malformed registration
  try {
    const $b24 = b24Instance.getOrThrow()
    const res = await $b24.actions.v2.call.make({ method: call.method, params: call.params })
    triggerRegistered.value = res.isSuccess
      ? 'ok'
      : `ошибка: ${res.getErrorMessages().join('; ')}`
  } catch (error: unknown) {
    // Swallowed on purpose — the core install (token delivery) already succeeded.
    console.warn('[install] trigger.add', error)
    triggerRegistered.value = `ошибка: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Runs the install flow. Surfaces failures as a retryable error state instead
 *  of throwing (a thrown error would leave the page stuck with no way out).
 *  placement.bind is intentionally not done here yet — the app's in-portal pages
 *  are opened via the handler registered in the B24 app config; specific
 *  placements are finalised on the test portal (see docs/REFACTOR_PLAN.md). */
async function runInstall() {
  if (isRunning.value) return
  isRunning.value = true
  installError.value = ''
  progressColor.value = 'air-primary'
  progressValue.value = null
  try {
    const ready = await waitForB24()

    if (!ready) {
      // Вне портала установка невозможна в принципе. Раньше здесь крутился фальшивый прогресс и
      // редирект на лендинг; теперь объяснение показывает общий `InPortalGate` (#414) — одна
      // заглушка на все страницы приложения вместо трёх разных поведений. Просто выходим.
      // Прогресс переводим в определённое состояние: иначе полоса крутилась бы вечно (видно под
      // `?preview=1`, где тело страницы рендерится).
      caption.value = 'Вне портала Bitrix24 — установка недоступна'
      progressColor.value = 'air-primary-warning'
      progressValue.value = 100
      return
    }

    const $b24 = b24Instance.getOrThrow()
    caption.value = 'Запрос данных портала…'
    await $b24.parent.setTitle('Установка приложения')

    // Read-only diagnostics: app metadata + granted scopes. We don't fetch the
    // user profile — it isn't shown and would only park PII in reactive state.
    const response = await $b24.actions.v2.batch.make({
      calls: {
        appInfo: { method: 'app.info' },
        scope: { method: 'scope' },
        eventList: { method: 'event.get' }
      }
    })
    // Батч мог отработать частично. Если `scope` не прочитан, судить о правах НЕЛЬЗЯ: пустой
    // список выглядел бы как «портал не выдал НИ ОДНОГО права» и давал бы громкий ложный вердикт
    // на успешной установке — ровно та ошибка, которую этот экран и должен устранять.
    if (!response.isSuccess) throw new Error(`Не удалось прочитать данные портала: ${response.getErrorMessages().join('; ')}`)
    initData.value = response.getData() as InitData

    // Register the backend event handlers before finishing — see bindEvents().
    caption.value = 'Регистрация обработчика событий…'
    await bindEvents()

    // Register the app's automation trigger (best-effort, never blocks — see registerTrigger()).
    caption.value = 'Регистрация триггера автоматизации…'
    await registerTrigger()

    caption.value = 'Завершение установки…'
    progressColor.value = 'air-primary-success'
    progressValue.value = 100
    await sleep(800)
    await $b24.installFinish()
    finished.value = true
    // Событие установки идёт мимо iframe — прямо на backend. Проверяем, что оно дошло, иначе
    // портал «установлен», а серверная часть о нём не знает и импорт не заработает (#413).
    caption.value = 'Проверка серверной части…'
    checkingBackend.value = true
    try {
      backendState.value = await checkBackendKnowsPortal()
    } finally {
      checkingBackend.value = false
    }
    caption.value = 'Готово'
  } catch (error: unknown) {
    console.error('[install]', error)
    progressColor.value = 'air-primary-alert'
    installError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isRunning.value = false
  }
}

onMounted(runInstall)
</script>

<template>
  <!-- Установка возможна только внутри портала (#414) — снаружи страница показывает общую
       заглушку вместо фальшивого прогресса и редиректа. -->
  <InPortalGate>
    <div class="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
      <div class="flex w-full max-w-2xl flex-col items-center gap-4">
        <h1 class="text-center text-2xl font-bold text-(--ui-color-base-1)">
          {{ LANDING_TITLE }}
        </h1>

        <B24Progress
          v-model="progressValue"
          size="xs"
          animation="elastic"
          :color="progressColor"
          class="w-1/2"
        />

        <div
          v-if="installError"
          class="flex flex-col items-center gap-2 text-center"
        >
          <p class="text-sm font-medium text-(--ui-color-accent-main-alert)">
            Ошибка установки
          </p>
          <p class="max-w-md break-all text-xs text-(--ui-color-base-3)">
            {{ installError }}
          </p>
          <B24Button
            label="Повторить"
            color="air-primary"
            size="sm"
            :disabled="isRunning"
            @click="runInstall"
          />
        </div>
        <p
          v-else
          class="text-sm text-(--ui-color-base-3)"
        >
          {{ caption }}
        </p>

        <!-- Вердикт (#410): «Готово» больше не означает «всё работает». Недовыданные права раньше
           были видны только в свёрнутой диагностике мелкими бейджами — то есть не были видны.
           Живая область: вердикт появляется асинхронно, и без неё скринридер о нём не сообщит.
           role="alert" сам по себе live (assertive) — явный aria-live="polite" ему противоречил
           и поведение зависело от прочтения браузером (U4, #430). -->
        <div
          class="w-full"
          role="alert"
        >
          <B24Alert
            v-if="isUseB24 && !checkingBackend && verdict.level !== 'ok' && !isRunning && !installError"
            :color="verdict.level === 'failed' ? 'air-primary-alert' : 'air-primary-warning'"
            :title="verdict.title"
            class="mt-4 w-full"
            data-testid="install-verdict"
          >
            <template #description>
              <ul class="mt-1 flex list-disc flex-col gap-2 pl-4">
                <li
                  v-for="(issue, n) in verdict.issues"
                  :key="n"
                >
                  {{ issue.title }}
                  <span
                    v-if="issue.action"
                    class="block opacity-80"
                  >{{ issue.action }}</span>
                </li>
              </ul>
            </template>
          </B24Alert>

          <B24Alert
            v-else-if="isUseB24 && !checkingBackend && verdict.level === 'ok' && !isRunning && !installError"
            color="air-primary-success"
            :title="verdict.title"
            description="Все запрошенные права выданы. Дальше — настройте приложение: подключите банк и выберите чат для уведомлений."
            class="mt-4 w-full"
            data-testid="install-verdict"
          />
        </div>

        <B24Accordion
          v-model="diagOpen"
          :items="[{ label: 'Диагностика', value: 'diag', slot: 'diag' }]"
          type="multiple"
          class="mt-4 w-full"
        >
          <template #diag>
            <div class="flex flex-col gap-3 p-2 font-mono text-sm">
              <div class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
                <span class="text-(--ui-color-base-3)">Режим:</span>
                <span>{{ diagnostics.mode }}</span>
                <span class="text-(--ui-color-base-3)">Домен:</span>
                <span>{{ diagnostics.domain || '—' }}</span>
                <span class="text-(--ui-color-base-3)">member_id:</span>
                <span class="break-all">{{ diagnostics.memberId || '—' }}</span>
                <span class="text-(--ui-color-base-3)">targetOrigin:</span>
                <span class="break-all">{{ diagnostics.targetOrigin }}</span>
                <span class="text-(--ui-color-base-3)">Обработчик событий:</span>
                <span class="break-all">{{ diagnostics.eventHandler }}</span>
                <template v-if="diagnostics.trigger">
                  <span class="text-(--ui-color-base-3)">Триггер автоматизации:</span>
                  <span class="break-all">{{ diagnostics.trigger }}</span>
                </template>
                <template v-if="diagnostics.appInfo">
                  <span class="text-(--ui-color-base-3)">App:</span>
                  <span>{{ diagnostics.appInfo.CODE }} (id {{ diagnostics.appInfo.ID }}, v{{ diagnostics.appInfo.VERSION }})</span>
                </template>
              </div>

              <div
                v-if="diagnostics.granted.length || diagnostics.missing.length"
                class="flex flex-col gap-1"
              >
                <span class="text-(--ui-color-base-3)">Права:</span>
                <div class="flex flex-wrap gap-1">
                  <B24Badge
                    v-for="s in diagnostics.granted"
                    :key="`g-${s}`"
                    :label="s"
                    color="air-primary-success"
                    size="sm"
                  />
                  <B24Badge
                    v-for="s in diagnostics.missing"
                    :key="`m-${s}`"
                    :label="`${s} (нет)`"
                    color="air-primary-alert"
                    size="sm"
                  />
                </div>
              </div>

              <div class="flex flex-col gap-1">
                <span class="text-(--ui-color-base-3)">События:</span>
                <div
                  v-if="diagnostics.events.length === 0"
                  class="italic text-(--ui-color-base-3)"
                >
                  нет привязок
                </div>
                <ul
                  v-else
                  class="m-0 flex list-none flex-col gap-1 p-0"
                >
                  <li
                    v-for="(e, i) in diagnostics.events"
                    :key="i"
                    class="break-all"
                  >
                    <strong>{{ e.event }}</strong> → {{ e.handler }}
                  </li>
                </ul>
              </div>
            </div>
          </template>
        </B24Accordion>
      </div>
    </div>
  </InPortalGate>
</template>
