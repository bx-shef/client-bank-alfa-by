<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useB24 } from '~/composables/useB24'
import { B24_BOUND_EVENTS, B24_EVENT_HANDLER_PATH } from '~/config/b24'
import { buildEventBindCalls, type EventBinding } from '~/utils/b24EventBind'
import { LANDING_TITLE, pageTitle } from '~/utils/landing'

definePageMeta({ layout: 'clear' })

const router = useRouter()
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
    // Shown so operators can copy it for the server-side check (scripts/check-app-option.sh).
    memberId,
    targetOrigin: isUseB24.value ? b24Instance.targetOrigin() : '—',
    // Backend events handler the install script binds — surfaced so a misconfigured
    // (empty / relative) URL is obvious on the diagnostics panel.
    eventHandler: isUseB24.value ? (eventHandlerUrl.value || '—') : '—',
    appInfo: initData.value.appInfo,
    granted,
    missing,
    events: initData.value.eventList ?? []
  }
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForB24(timeoutMs = 10000): Promise<boolean> {
  await b24Instance.init()
  const start = Date.now()
  while (!isUseB24.value && (Date.now() - start) < timeoutMs) {
    await sleep(100)
  }
  return isUseB24.value
}

/** Binds the server-event handlers (ONAPPINSTALL/ONAPPUNINSTALL) to the backend
 *  endpoint. Must run BEFORE installFinish so the current install's ONAPPINSTALL
 *  (which carries the application_token + OAuth creds) is delivered. Idempotent:
 *  re-installs skip already-correct bindings and re-point stale ones. */
async function bindEvents(): Promise<void> {
  const $b24 = b24Instance.getOrThrow()

  // A relative/empty handler URL would register a dead binding B24 could never
  // reach. Refuse rather than ship a broken portal (needs NUXT_PUBLIC_SITE_URL).
  if (!appUrl || !/^https?:\/\//i.test(eventHandlerUrl.value)) {
    throw new Error(`Обработчик событий не абсолютный (${eventHandlerUrl.value || 'пусто'}). Задайте NUXT_PUBLIC_SITE_URL при сборке.`)
  }

  const existing = initData.value.eventList ?? []
  const { unbind, bind } = buildEventBindCalls(existing, B24_BOUND_EVENTS, eventHandlerUrl.value)

  // Best-effort cleanup of stale bindings — a missing one is fine, don't halt.
  if (unbind.length) await $b24.actions.v2.batch.make({ calls: unbind, options: { isHaltOnError: false } })

  // Bind the missing events. This is the whole point of the handler, so a failure
  // is fatal (surfaced as a retryable error) — a half-bound app never learns the token.
  if (bind.length) {
    const res = await $b24.actions.v2.batch.make({ calls: bind })
    if (!res.isSuccess) throw new Error(`event.bind не удался: ${res.getErrorMessages().join('; ')}`)
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
      // Standalone (opened directly, not in a portal) — show a brief mock and
      // send the visitor to the landing.
      caption.value = 'Вне портала Bitrix24 — демо-режим'
      progressColor.value = 'air-primary-warning'
      progressValue.value = 99
      await sleep(1500)
      await router.replace('/')
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
    initData.value = response.getData() as InitData

    // Register the backend event handlers before finishing — see bindEvents().
    caption.value = 'Регистрация обработчика событий…'
    await bindEvents()

    caption.value = 'Завершение установки…'
    progressColor.value = 'air-primary-success'
    progressValue.value = 100
    await sleep(800)
    await $b24.installFinish()
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

      <B24Accordion
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
              <span class="text-(--ui-color-base-3)">Событий обработчик:</span>
              <span class="break-all">{{ diagnostics.eventHandler }}</span>
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
                  variant="soft"
                  size="sm"
                />
                <B24Badge
                  v-for="s in diagnostics.missing"
                  :key="`m-${s}`"
                  :label="`${s} (нет)`"
                  color="air-primary-alert"
                  variant="soft"
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
</template>
