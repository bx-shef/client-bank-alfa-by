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
import { QUEUE_META, type QueueCounts, type QueuesSnapshot } from '~/utils/queueChart'
import { pageTitle } from '~/utils/landing'

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
</script>

<template>
  <AuthGate>
    <main class="mx-auto max-w-5xl px-4 py-8">
      <header class="mb-5">
        <h1 class="text-2xl font-bold text-(--ui-color-base-1)">
          Монитор очередей обработки
        </h1>
        <p class="mt-1 text-sm text-(--ui-color-base-3)">
          Живой график длины очередей (backlog = ждут + в работе). Источник —
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
        :interval-sec="5"
        :max-points="60"
      />
    </main>
  </AuthGate>
</template>
