<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { useBankKeyScreen } from '~/composables/useBankKeyScreen'
import { copyToClipboard } from '~/utils/clipboard'
import { ALFA_BUSINESS_ONLINE_HOST, ALFA_BUSINESS_ONLINE_NAME, ALFA_BUSINESS_ONLINE_URL } from '~/utils/bankConnectInvite'
import { pageTitle } from '~/utils/landing'

// Экран ВЛАДЕЛЬЦА СЧЁТА: он выпустил ключ API в кабинете банка и вставляет его сюда (#19).
//
// ⚠ ЕДИНСТВЕННЫЙ ЭКРАН ПРИЛОЖЕНИЯ, КОТОРЫЙ ОТКРЫВАЕТ НЕ АДМИНИСТРАТОР. Всё остальное в настройках
// закрыто `profile.ADMIN`; здесь право даёт подписанный грант, выданный админом конкретному
// сотруднику, плюс совпадение личности с фрейм-токеном — разбор в `server/utils/bankKeySubmit.ts`.
//
// ⚠ ЗАЧЕМ ЭКРАН ВООБЩЕ. Ключ API бессрочен и не ротируется. Присланный администратору в чат, он
// остался бы в истории портала навсегда, а отозвать его можно только в кабинете банка. Здесь ключ
// вводит тот, кто его выпустил, — и админ его не видит вовсе.
definePageMeta({ layout: 'portal' })

useHead({
  title: pageTitle('Подключение банка'),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }]
})

const b24 = useB24()
const screen = useBankKeyScreen()
const apiKey = ref('')
const token = ref('')
const clientIdCopied = ref(false)
// Подпись ссылки шага 1 — выражением, а не текстом в разметке: у многострочного элемента текст
// внутри получил бы пробелы по краям, и перед точкой после ссылки встал бы лишний пробел.
// ⚠ Домен назван в подписи — по этой ссылке вводят пароль от интернет-банка (то же правило, что в
// сообщении чата).
const bankOnlineLabel = `${ALFA_BUSINESS_ONLINE_NAME} (${ALFA_BUSINESS_ONLINE_HOST})`

onMounted(async () => {
  await b24.init().catch(() => {})
  // Грант приезжает тем же путём, что и `place`: `params[t]` в внутренней ссылке портала.
  token.value = b24.placementParam('t') ?? ''
  await screen.check(token.value)
})

async function onCopyClientId() {
  if (!screen.clientId.value) return
  // Тот же общий помощник, что в карточке подключения: во фрейме портала Clipboard API закрыт
  // политикой, а фолбэк через `execCommand` работает.
  if (await copyToClipboard(screen.clientId.value)) {
    clientIdCopied.value = true
    setTimeout(() => {
      clientIdCopied.value = false
    }, 2500)
    return
  }
  screen.error.value = 'Не удалось скопировать — выделите значение в поле и скопируйте вручную'
}

async function onSubmit() {
  const ok = await screen.submit(token.value, apiKey.value)
  // ⚠ Ключ стираем из поля СРАЗУ и в любом исходе: он бессрочный, а вкладка остаётся открытой.
  if (ok) apiKey.value = ''
}
</script>

<template>
  <InPortalGate>
    <div class="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <div>
        <h1 class="text-xl font-semibold">
          Подключение банка
        </h1>
        <p class="text-sm text-(--ui-color-base-3)">
          Вставьте ключ API, который вы выпустили в кабинете банка.
        </p>
      </div>

      <p
        v-if="screen.checking.value"
        class="text-sm text-(--ui-color-base-3)"
        role="status"
      >
        Проверяем ссылку…
      </p>

      <B24Alert
        v-else-if="screen.done.value"
        color="air-primary-success"
        description="Готово — банк подключён. Эту вкладку можно закрыть, дальше всё сделает администратор портала."
        data-testid="key-done"
      />

      <template v-else-if="screen.ready.value">
        <!-- Инструкция ПОВТОРЯЕТСЯ здесь, а не только в сообщении чата: человек мог дойти сюда
             через день и сообщение уже не искать. Надписи — дословно как в кабинете банка.
             ⚠ Снимки кабинета — те же, что во вложении сообщения, и после тех же шагов
             (`AlfaKeyShotImage` читает общий манифест). Номера шагов здесь совпадают с номерами в
             сообщении; компонент стоит в КАЖДОМ шаге, чтобы новый снимок не требовал правки
             разметки. Надписи кабинета (всё, что выделено жирным) обязаны совпадать с шагами
             сообщения — это держит тест. -->
        <div
          class="rounded-md bg-(--ui-color-base-8) p-3 text-sm text-(--ui-color-base-2)"
          data-testid="key-steps"
        >
          <p class="mb-2 font-semibold">
            Как получить ключ API
          </p>
          <ol class="ml-4 list-decimal space-y-3">
            <li>
              Войдите в
              <!-- ⚠ Цвет задан явно: штатный цвет ссылки на белом фоне даёт 4.21:1 при пороге 4.5:1
                   (`blue-80` — 5.04:1). В тёмной теме штатный проходит (4.9:1) и остаётся. -->
              <B24Link
                :href="ALFA_BUSINESS_ONLINE_URL"
                target="_blank"
                rel="noopener noreferrer"
                class="font-semibold text-(--ui-color-blue-80) dark:text-(--ui-color-design-selection-content)"
                data-testid="key-bank-link"
              >
                {{ bankOnlineLabel }}
              </B24Link>.
              <AlfaKeyShotImage :step="1" />
            </li>
            <li>
              <b>Настройки</b> → вкладка <b>Open API</b> → кнопка <b>«Сгенерировать ключ API»</b>.
              <AlfaKeyShotImage :step="2" />
            </li>
            <li>
              Заполните форму <b>«Генерация ключа API»</b>:
              <!-- ⚠ По полю формы на строку — как в сообщении чата (замечание владельца 2026-09-28:
                   одной строкой три поля читались «в одну кучу»). -->
              <!-- ⚠ Client ID — ПРЯМО В ШАГЕ, а не «значение ниже» (находка ревью): под шагами стоят
                   два снимка во всю ширину, и поле с кнопкой копирования уезжало на ~1100 px вниз. -->
              <ul class="mt-1 ml-4 list-disc space-y-0.5">
                <li><b>НАЗВАНИЕ</b> — любое понятное, например «Подключение к Б24»</li>
                <li>
                  <b>CLIENT ID</b> — скопируйте значение:
                  <div
                    v-if="screen.clientId.value"
                    class="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center"
                    data-testid="key-client-id-field"
                  >
                    <B24Input
                      :model-value="screen.clientId.value"
                      readonly
                      aria-label="Client ID для кабинета банка"
                      class="w-full font-mono text-xs"
                      data-testid="key-client-id"
                      @focus="(e: FocusEvent) => (e.target as HTMLInputElement)?.select()"
                    />
                    <B24Button
                      color="air-secondary-accent"
                      class="shrink-0"
                      data-testid="key-copy-client-id"
                      @click="onCopyClientId"
                    >
                      {{ clientIdCopied ? 'Скопировано' : 'Скопировать' }}
                    </B24Button>
                  </div>
                </li>
                <li><b>ТИП КЛЮЧА</b> — <b>Постоянный ключ</b></li>
              </ul>
              <AlfaKeyShotImage :step="3" />
            </li>
            <li>
              Согласитесь с условиями и нажмите <b>«Сгенерировать ключ»</b>.
              <AlfaKeyShotImage :step="4" />
            </li>
            <li>
              Раскройте строку ключа, нажмите <b>«Скопировать ключ»</b> — и вставьте его в поле ниже.
              <AlfaKeyShotImage :step="5" />
            </li>
          </ol>
        </div>

        <B24FormField
          label="Ключ API"
          description="Ключ никому не пересылайте — он открывает доступ к выписке по счёту. Заблокировать или отозвать его можно в кабинете банка."
          data-testid="key-field"
        >
          <B24Input
            v-model="apiKey"
            type="password"
            placeholder="Вставьте скопированный ключ"
            class="w-full font-mono text-xs"
            data-testid="key-input"
          />
        </B24FormField>

        <B24Button
          :loading="screen.submitting.value"
          :disabled="screen.submitting.value || !apiKey.trim()"
          :aria-busy="screen.submitting.value"
          color="air-primary"
          class="self-start"
          data-testid="key-submit"
          @click="onSubmit"
        >
          Подключить
        </B24Button>
      </template>

      <B24Alert
        v-if="screen.error.value"
        color="air-primary-alert"
        :description="screen.error.value"
        data-testid="key-error"
      />
    </div>
  </InPortalGate>
</template>
