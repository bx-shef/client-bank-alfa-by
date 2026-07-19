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
import { onMounted } from 'vue'
import { QUEUE_META, type QueueCounts, type QueuesSnapshot } from '~/utils/queueChart'
import { pageTitle } from '~/utils/landing'
import { useAppRatingOps, type RatingState } from '~/composables/useAppRatingOps'

definePageMeta({ layout: 'clear', middleware: 'auth' })

// Tab title from the single source (pageTitle → "<section> — <app name>").
useHead({
  title: pageTitle('Очереди'),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }]
})

// `?preview=1` → client-side generator (no-backend, doesn't poll). Decided at FETCH
// time from the real browser URL — a prerendered page's `useRoute().query` isn't
// populated during setup/hydration, and the fetcher only runs client-side
// (QueueMonitor's onMounted), so `window` is always available here.
function isPreview(): boolean {
  return import.meta.client && new URLSearchParams(window.location.search).has('preview')
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
for (const q of QUEUE_META) state[q.name] = { waiting: 2, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }

const rnd = (n: number) => Math.floor(Math.random() * (n + 1))

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
    if (Math.random() < 0.06) s.failed += 1
  }
  return Promise.resolve({ enabled: true, queues: structuredClone(state) })
}

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
// Best-effort — the rating card is independent of the queue chart (it drives its own fetch).
onMounted(() => {
  void rating.load()
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

      <QueueMonitor
        :fetcher="fetcher"
        title="Очереди обработки"
        :range-min="10"
        :max-points="400"
      />

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
