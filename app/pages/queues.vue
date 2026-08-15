<script setup lang="ts">
// Ops page: a live chart of BullMQ queue lengths (QueueMonitor + ECharts).
//
// Source is GET /api/ops/queues — gated by the OPERATOR SESSION cookie, so a
// logged-in employee's browser can read it (unlike /api/queues, which needs the
// B24_APPLICATION_TOKEN and is nginx-denied). `?preview=1` swaps in a client-side
// generator (fabricated numbers in the browser) that does NOT poll the queues —
// for screenshots / no-backend dev. NB: this is unrelated to the backend
// DEMO_LOAD_N load, which drives the REAL queues; preview is a pure front-end fake.
// `clear` layout → b24ui theming + dark; <AuthGate> keeps protected chrome from
// flashing before the auth redirect; `noindex`. See docs/QUEUES.md, docs/AUTH.md.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { QUEUE_META, type QueueCounts, type QueuesSnapshot } from '~/utils/queueChart'
import { pageTitle } from '~/utils/landing'
import { useAppRatingOps, type RatingState } from '~/composables/useAppRatingOps'
import { HEALTH_TONE_COLOR, presentQueueHealth, type QueueHealthPayload, type QueueHealthView } from '~/utils/queueHealthView'
import { attentionHeadline, bankHealthRows, PREVIEW_BANK_HEALTH, spreadLabel, type BankHealthOverview } from '~/utils/bankHealthOverview'
import { formatRelativeTime } from '~/utils/importStatus'
import type { KeepAlivePulseSummary } from '~/utils/keepAlivePulse'

definePageMeta({ layout: 'clear', middleware: 'auth' })

// Tab title from the single source (pageTitle → "<section> — <app name>").
useHead({
  title: pageTitle('Очереди'),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }]
})

// `?preview=1` → client-side generator (no-backend, doesn't poll).
//
// ⚠ Флаг РЕАКТИВНЫЙ и читается из роутера. Обе «очевидные» реализации на статике не работают:
// на гидратации пререндеренной страницы `window.location.search` ЕЩЁ ПУСТ (проверено — в момент
// `onMounted` там пусто, а через пару секунд уже `?preview=1`), и `route.query` в этот момент тоже
// пуст. Разовая проверка при монтировании поэтому всегда давала false. У графика это не всплывало
// только потому, что `QueueMonitor` опрашивает `fetcher()` по таймеру и рано или поздно попадает
// в момент, когда запрос уже разобран, — то есть превью «чинилось» само, но не сразу.
// Родственная ошибка уже ловилась в `InPortalGate` (#414, CLAUDE.md «Встройка в Bitrix24»).
// Найдено скриншотом: карточка здоровья на статике рендерилась как «эндпоинт недоступен».
const route = useRoute()
const preview = computed(() => 'preview' in route.query
  || (import.meta.client && new URLSearchParams(window.location.search).has('preview')))

function isPreview(): boolean {
  return preview.value
}

/** Chosen source: preview generator with `?preview=1`, else the session-gated
 *  endpoint (same-origin → the cba_sess cookie is sent). */
function fetcher(): Promise<QueuesSnapshot> {
  return isPreview() ? previewFetcher() : liveFetcher()
}

/** Real source: session-gated endpoint. */
function liveFetcher(): Promise<QueuesSnapshot> {
  return $fetch<QueuesSnapshot>('/api/ops/queues')
}

// Превью-состояние: у каждой очереди дрейфующие счётчики, чтобы график «жил».
const state: Record<string, QueueCounts> = {}
for (const q of QUEUE_META) state[q.name] = { waiting: 2, active: 0, completed: 0, failed: 0, delayed: 0 }

// ⚠ ДЕТЕРМИНИРОВАННЫЙ псевдослучайный генератор, а не `Math.random()`. Превью — это ещё и то,
// что снимают визуальные регресс-тесты (#3): со стенным рандомом таблица очередей и заголовок
// «сейчас в очереди N» менялись бы в каждом прогоне, то есть эталон был бы либо мигающим, либо
// зелёным лишь потому, что расхождение укладывается в допуск. Seed фиксирован — превью выглядит
// «живым» (счётчики дрейфуют от тика к тику), но одинаково от запуска к запуску.
let seed = 0x2f6e2b1
function nextRandom(): number {
  // xorshift32 — три строки, без зависимостей, период с запасом для десятка тиков.
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 0x1_0000_0000
}
const rnd = (n: number) => Math.floor(nextRandom() * (n + 1))

/** Превью-загрузчик (только `?preview=1`): синтетика в браузере — двигает счётчики
 * (waiting дрейфует, часть уходит в active → completed, изредка failed), форма как у
 * GET /api/ops/queues. Очереди НЕ опрашивает. */
function previewFetcher(): Promise<QueuesSnapshot> {
  for (const q of QUEUE_META) {
    const s = state[q.name]!
    const arrived = rnd(q.main ? 4 : 3)
    const capacity = Math.min(s.waiting + arrived, 1 + rnd(3))
    s.waiting = Math.max(0, s.waiting + arrived - capacity)
    s.active = capacity
    s.completed += capacity
    if (nextRandom() < 0.06) s.failed += 1
  }
  return Promise.resolve({ enabled: true, queues: structuredClone(state) })
}

// Состояние банковских подключений по ВСЕМ порталам (#497 §3). Сегодня умирающее подключение
// узнаётся по факту неработающего импорта — то есть позже клиента; критерий приёмки тестовой
// эксплуатации сформулирован ровно наоборот. Ответ несёт только счётчики: ни номеров счетов, ни
// идентификаторов порталов — оператору нужно «что-то ломается и у скольких», а не чужие реквизиты.
const bankHealth = ref<BankHealthOverview | null>(null)
const bankHealthError = ref('')
// Когда продление токенов последний раз отработало (#504). Живёт рядом с карточкой подключений,
// потому что отвечает на вопрос про них: «а механизм, который их держит, вообще жив?»
const keepAliveAt = ref<number | null>(null)
const keepAliveSummary = ref<KeepAlivePulseSummary | null>(null)
const keepAliveLine = computed(() => {
  if (keepAliveAt.value === null) return 'Продление токенов: прогонов ещё не было (после перезапуска это нормально).'
  // `formatRelativeTime` принимает ISO — общий формат статуса импорта, не заводим второй.
  const when = formatRelativeTime(new Date(keepAliveAt.value).toISOString(), Date.now())
  const s = keepAliveSummary.value
  // Итог прогона показываем, а не возим вхолостую: «отработало 5 минут назад» и «отработало 5 минут
  // назад, из них 3 не удалось» — разные новости, и вторая объясняет, почему подключения всё равно
  // мрут. Молчим только когда сказать нечего (в полосе обновления никого не было).
  if (!s || (s.refreshed === 0 && s.failed === 0)) return `Продление токенов: ${when}.`
  const failed = s.failed > 0 ? `, не удалось ${s.failed}` : ''
  return `Продление токенов: ${when} — обновлено ${s.refreshed}${failed}.`
})

async function loadBankHealth(): Promise<void> {
  if (isPreview()) {
    // ⚠ Превью-ветка ОБЯЗАТЕЛЬНА, и ровно по той же причине, что у вердикта здоровья выше: без неё
    // карточка на статике уходит в «не удалось прочитать» (эндпоинта там нет), то есть эталон
    // скриншота документирует не интерфейс, а его отказ. Хуже — она делает снимок НЕДЕТЕРМИНИРОВАННЫМ:
    // ответ 404 приходит асинхронно, высота страницы меняется между кадрами, и визуальный тест
    // краснеет мигая, а не по делу. Синтетика намеренно показывает ИНТЕРЕСНЫЙ случай (есть
    // требующие человека и есть незавершённые) — карточка, снятая в состоянии «всё хорошо»,
    // не показывает ничего из того, ради чего она сделана.
    bankHealth.value = PREVIEW_BANK_HEALTH
    // Снять флаг обязательно: запрос роутер разбирает уже ПОСЛЕ монтирования, поэтому первый
    // прогон успевает сходить в сеть и упасть, а блок ошибки в шаблоне идёт первым.
    bankHealthError.value = ''
    return
  }
  try {
    const res = await $fetch<{ ok?: boolean } & BankHealthOverview>('/api/ops/bank-health')
    bankHealth.value = res
    bankHealthError.value = ''
  } catch (e) {
    // ⚠ Ошибку читаем ИЗ ИСКЛЮЧЕНИЯ, а не из разрешённого значения. `$fetch` (ofetch) бросает на
    // любом не-2xx, а роут отдаёт `ok:false` ТОЛЬКО вместе с не-2xx (401/503) — поэтому ветка
    // «резолвилось, но ok:false» недостижима, и написанная так проверка молча теряла бы разницу
    // между «сессия истекла» и «база недоступна». Тот же разбор, что в `frameFetchError`.
    //
    // ⚠ Ошибку показываем, а не подменяем нулями: пустая сводка читалась бы как «всё спокойно»
    // ровно тогда, когда спокойно точно не всё.
    const said = (e as { data?: { error?: string } })?.data?.error
    bankHealthError.value = said || 'не удалось прочитать состояние подключений'
  }
}

// Строки и заголовок считает чистое ядро (склонения — через общий `pluralRu`), страница только рисует.
const bankRows = computed(() => bankHealth.value ? bankHealthRows(bankHealth.value) : [])
const bankHeadline = computed(() => bankHealth.value ? attentionHeadline(bankHealth.value) : '')

// «Оцените приложение» — per-portal review lifecycle the owner manages here (not via SQL).
const rating = useAppRatingOps()
const RATING_META: Record<RatingState, { label: string, cls: string }> = {
  opened: { label: 'открыл Маркет — проверьте отзыв', cls: 'text-(--ui-color-accent-main-warning)' },
  prompted: { label: 'показан, Маркет не открыл', cls: 'text-(--ui-color-base-3)' },
  none: { label: 'ещё не показывался', cls: 'text-(--ui-color-base-4)' },
  reviewed: { label: 'отзыв подтверждён', cls: 'text-(--ui-color-accent-main-success)' }
}
function fmtDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleDateString('ru-RU') : '—'
}
// Здоровье конвейера (#426). Отдельно от графика: график показывает ГЛУБИНУ (снимок), а он не
// отличает «навалило работы» от «встало» — вердикт выносит периодическая проверка на крон-инстансе.
// Пустой список тревог тут НЕ равен «всё хорошо»: смысл зависит от свежести проверки, поэтому вся
// логика — в чистом `presentQueueHealth`, а страница только рисует.
const health = shallowRef<QueueHealthView | null>(null)
const healthFailed = ref(false)
let healthTimer: ReturnType<typeof setInterval> | undefined

async function loadHealth() {
  if (isPreview()) {
    // Превью фабрикует ВСЮ страницу (счётчики очередей — тоже), поэтому и вердикт синтетический:
    // иначе карточку нельзя было бы ни увидеть в разработке, ни снять на скриншот. Страница явно
    // помечена как синтетика — молча пропускать этот блок было бы хуже, чем показать пример.
    health.value = presentQueueHealth({
      alerts: [{ kind: 'stalled', queue: 'crm-sync', text: 'очередь «crm-sync» не разгребается: 4 задачи ждут, самая старая — уже 25 мин' }],
      alertsCheckedAt: Date.now() - 60_000
    }, Date.now())
    // Синтетический пульс — иначе на статике карточка показывала бы «прогонов ещё не было», и
    // эталон снимка документировал бы пустое состояние вместо рабочего.
    keepAliveAt.value = Date.now() - 12 * 60_000
    keepAliveSummary.value = { selected: 3, refreshed: 2, skipped: 0, failed: 1, unrefreshable: 1, expired: 0 }
    // ⚠ Обязательно снять флаг ошибки: запрос роутер разбирает уже ПОСЛЕ монтирования, поэтому
    // первый прогон успевает сходить в сеть и упасть, а карточка ошибки в шаблоне идёт первой и
    // перекрыла бы вердикт. Без этой строки превью-карточка не появлялась вовсе.
    healthFailed.value = false
    return
  }
  try {
    const payload = await $fetch<QueueHealthPayload & { keepAliveAt?: number | null, keepAliveSummary?: KeepAlivePulseSummary | null }>('/api/ops/queues')
    health.value = presentQueueHealth(payload, Date.now())
    // Пульс продления банковских токенов (#504) — приезжает тем же запросом. `null` = прогонов в
    // этом процессе не было; это НЕ «всё хорошо», и подпись обязана сказать именно так.
    keepAliveAt.value = payload?.keepAliveAt ?? null
    keepAliveSummary.value = payload?.keepAliveSummary ?? null
    healthFailed.value = false
  } catch {
    // Недоступный эндпоинт — тоже информация: молча оставить прошлый (возможно зелёный) вердикт
    // значило бы показывать «всё хорошо» при мёртвом бэкенде.
    healthFailed.value = true
  }
}

// Best-effort — the rating card is independent of the queue chart (it drives its own fetch).
// Запрос разбирается роутером уже ПОСЛЕ монтирования, поэтому недостаточно спросить один раз:
// перечитываем вердикт, когда флаг превью наконец становится известен. Обе карточки, а не одна:
// у них общий источник недетерминизма — момент, когда `?preview=1` наконец разобран.
watch(preview, () => {
  void loadHealth()
  void loadBankHealth()
})

onMounted(() => {
  void rating.load()
  void loadHealth()
  void loadBankHealth()
  // Реже графика: вердикт обновляется раз в 5 минут на сервере, чаще опрашивать нечего.
  healthTimer = setInterval(() => {
    void loadHealth()
    // Состояние подключений меняется часами, а не секундами — на том же тике и достаточно.
    void loadBankHealth()
  }, 60_000)
})
onBeforeUnmount(() => {
  if (healthTimer) clearInterval(healthTimer)
})
</script>

<template>
  <AuthGate>
    <main class="mx-auto max-w-6xl px-4 py-8">
      <header class="mb-5">
        <h1 class="text-2xl font-bold text-(--ui-color-base-1)">
          Монитор очередей обработки
        </h1>
        <p class="mt-1 text-sm text-(--ui-color-base-3)">
          Сколько задач сейчас в очереди на каждом этапе (ждут и в обработке), а не сколько
          уже обработано. Источник —
          <code class="rounded bg-(--ui-color-design-tinted-na-bg) px-1.5 py-0.5">GET /api/ops/queues</code>
          (по сессии оператора). Флаг
          <code class="rounded bg-(--ui-color-design-tinted-na-bg) px-1.5 py-0.5">?preview=1</code>
          показывает синтетику из браузера и <strong>очереди не опрашивает</strong> (для скриншотов и
          разработки без бэкенда). Подробнее — <code>docs/QUEUES.md</code>.
        </p>
      </header>

      <!-- Вердикт проверки здоровья (#426) — над графиком: график показывает глубину, а «встало
           или разгребается» решает проверка. Тон и текст считает чистый `presentQueueHealth`. -->
      <B24Alert
        v-if="healthFailed"
        color="air-primary-warning"
        title="Не удалось получить состояние проверки здоровья"
        description="Эндпоинт /api/ops/queues недоступен. Тревог не видно — это не значит, что их нет."
        class="mb-4"
        data-testid="queue-health-failed"
      />
      <B24Alert
        v-else-if="health"
        :color="HEALTH_TONE_COLOR[health.tone]"
        :title="health.note"
        class="mb-4"
        data-testid="queue-health"
      >
        <template
          v-if="health.alerts.length"
          #description
        >
          <ul class="mt-1 flex list-disc flex-col gap-1 pl-4">
            <li
              v-for="(a, i) in health.alerts"
              :key="`${a.kind}:${a.queue}:${i}`"
            >
              {{ a.text }}
            </li>
          </ul>
        </template>
      </B24Alert>

      <QueueMonitor
        :fetcher="fetcher"
        title="Очереди обработки"
        :range-min="10"
        :max-points="400"
      />

      <!-- Состояние банковских подключений по всем порталам (#497 §3). Строки идут «сначала то,
           что требует человека»: экран, начинающийся с «всё хорошо», прячет единственную строку,
           ради которой его открыли. -->
      <B24Card
        v-if="bankHealth || bankHealthError"
        class="mt-6"
        data-testid="bank-health"
      >
        <template #header>
          <h2 class="font-semibold text-(--ui-color-base-1)">
            Подключения банков
          </h2>
        </template>

        <p
          v-if="bankHealthError"
          class="text-sm text-(--ui-color-accent-main-alert)"
          role="alert"
        >
          {{ bankHealthError }}
        </p>

        <template v-else-if="bankHealth">
          <p
            v-if="!bankHealth.total.connections"
            class="text-sm text-(--ui-color-base-3)"
          >
            Подключений пока нет.
          </p>

          <template v-else>
            <p
              class="text-sm"
              :class="bankHealth.needAttention
                ? 'text-(--ui-color-accent-main-alert)'
                : 'text-(--ui-color-accent-main-success)'"
              data-testid="bank-health-headline"
            >
              {{ bankHeadline }}
            </p>

            <ul class="mt-3 space-y-1 text-sm">
              <li
                v-for="r in bankRows"
                :key="r.health"
                class="flex items-baseline justify-between gap-3"
                :data-testid="`bank-health-${r.health}`"
              >
                <span class="text-(--ui-color-base-2)">{{ r.title }}</span>
                <span class="text-(--ui-color-base-3)">{{ r.countLabel }}</span>
              </li>
              <!-- Ожидающие показываем отдельной строкой: формально они живы, но опрашивать по ним
                   нечего — админ не выбрал счёт. В «в порядке» им нельзя. -->
              <li
                v-if="bankHealth.pending.connections"
                class="flex items-baseline justify-between gap-3"
                data-testid="bank-health-pending"
              >
                <span class="text-(--ui-color-base-2)">счёт не выбран</span>
                <span class="text-(--ui-color-base-3)">
                  {{ spreadLabel(bankHealth.pending.connections, bankHealth.pending.portals) }}
                </span>
              </li>
            </ul>

            <!-- Метки требующих внимания порталов: без них «3 портала требуют внимания» — тупик,
                 по нему нельзя отличить «те же три, что вчера» от «ещё два новых». Метка
                 необратима (`portalHash`) и совпадает с `portal.hash` в телеметрии. -->
            <p
              v-if="bankHealth.attentionPortals?.length"
              class="mt-3 text-xs text-(--ui-color-base-4)"
              data-testid="bank-health-portals"
            >
              Порталы (метки телеметрии):
              <code
                v-for="h in bankHealth.attentionPortals"
                :key="h"
                class="ml-1 rounded bg-(--ui-color-design-tinted-na-bg) px-1.5 py-0.5"
              >{{ h }}</code>
            </p>

            <!-- Пульс механизма, который эти подключения держит (#504). Без него «всё живо» на
                 экране может означать «продление встало час назад, а умирать они начнут к ночи». -->
            <p
              class="mt-3 text-xs text-(--ui-color-base-4)"
              data-testid="bank-keepalive-pulse"
            >
              {{ keepAliveLine }}
            </p>

            <p class="mt-1 text-xs text-(--ui-color-base-4)">
              Всего {{ spreadLabel(bankHealth.total.connections, bankHealth.total.portals) }}.
              Номеров счетов, доменов и member_id здесь нет намеренно — только необратимые метки.
            </p>
          </template>
        </template>
      </B24Card>

      <!-- Оценки приложения — управление жизненным циклом «оцените приложение» вручную (не через SQL).
           После клика «Оценить» владелец проверяет отзыв в Маркете и отмечает результат кнопками. -->
      <B24Card
        v-if="rating.portals.value.length"
        class="mt-6"
      >
        <template #header>
          <h2 class="font-semibold text-(--ui-color-base-1)">
            Оценки приложения
          </h2>
        </template>

        <p class="text-sm text-(--ui-color-base-3)">
          После клика «Оценить» проверьте отзыв в Маркете и отметьте: «Отзыв оставлен» (попап больше
          не показывается) или «Сбросить» (покажется снова на следующем удачном импорте).
        </p>

        <p
          v-if="rating.message.value"
          class="mt-2 text-sm text-(--ui-color-accent-main-primary)"
          role="status"
        >
          {{ rating.message.value }}
        </p>

        <ul class="mt-4 flex flex-col divide-y divide-(--ui-color-design-tinted-na-stroke)">
          <li
            v-for="r in rating.portals.value"
            :key="r.memberId"
            class="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div class="min-w-0">
              <p class="truncate font-mono text-sm text-(--ui-color-base-1)">
                {{ r.domain }}
              </p>
              <p
                class="text-xs"
                :class="RATING_META[r.state].cls"
              >
                {{ RATING_META[r.state].label }}
                <span class="text-(--ui-color-base-4)">
                  · показан {{ fmtDate(r.promptedAtMs) }} · открыт {{ fmtDate(r.openedAtMs) }}
                </span>
              </p>
            </div>
            <div class="flex shrink-0 gap-2">
              <B24Button
                v-if="r.state !== 'reviewed'"
                label="Отзыв оставлен"
                color="air-primary-success"
                size="sm"
                :loading="rating.busy.value === r.memberId"
                :disabled="rating.busy.value !== ''"
                @click="() => rating.setRating(r.memberId, 'reviewed')"
              />
              <B24Button
                label="Сбросить"
                color="air-tertiary-no-accent"
                size="sm"
                :loading="rating.busy.value === r.memberId"
                :disabled="rating.busy.value !== ''"
                @click="() => rating.setRating(r.memberId, 'reset')"
              />
            </div>
          </li>
        </ul>
      </B24Card>
    </main>
  </AuthGate>
</template>
