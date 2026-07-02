<script setup lang="ts">
// Ops page: a live chart of BullMQ queue lengths (QueueMonitor + ECharts).
//
// Source is GET /api/ops/queues — gated by the OPERATOR SESSION cookie, so a
// logged-in employee's browser can read it (unlike /api/queues, which needs the
// B24_APPLICATION_TOKEN and is nginx-denied). `?demo=1` swaps in a client-side
// generator for a no-backend preview (screenshots / local dev). Internal ops view:
// `noindex` so it is not crawled on the public SSG domain. See docs/QUEUES.md, AUTH.md.
import { QUEUE_META, type QueueCounts, type QueuesSnapshot } from '~/utils/queueChart'

// Employee/ops area — gated by the operator login (client redirect to /login when
// a password is configured and there is no session; real protection is the
// session-checked /api/ops/queues endpoint). See docs/AUTH.md.
definePageMeta({ middleware: 'auth' })

useHead({
  title: 'Очереди — монитор',
  meta: [{ name: 'robots', content: 'noindex, nofollow' }]
})

// `?demo=1` → client-side generator (no-backend preview / screenshots). Decided at
// FETCH time from the real browser URL — a prerendered page's `useRoute().query`
// isn't populated during setup/hydration, and the fetcher only runs client-side
// (QueueMonitor's onMounted), so `window` is always available here.
function isDemo(): boolean {
  return import.meta.client && new URLSearchParams(window.location.search).has('demo')
}

/** Chosen source: demo generator with `?demo=1`, else the session-gated endpoint
 *  (same-origin → the cba_sess cookie is sent). */
function fetcher(): Promise<QueuesSnapshot> {
  return isDemo() ? demoFetcher() : liveFetcher()
}

/** Real source: session-gated endpoint. */
function liveFetcher(): Promise<QueuesSnapshot> {
  return $fetch<QueuesSnapshot>('/api/ops/queues')
}

// Демо-состояние: у каждой очереди дрейфующие счётчики, чтобы график «жил».
const state: Record<string, QueueCounts> = {}
for (const q of QUEUE_META) state[q.name] = { waiting: 2, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }

const rnd = (n: number) => Math.floor(Math.random() * (n + 1))

/** Демо-загрузчик (только `?demo=1`): продвигает счётчики (waiting дрейфует, часть
 * уходит в active → completed, изредка failed), форма как у GET /api/ops/queues. */
function demoFetcher(): Promise<QueuesSnapshot> {
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
  <main class="q-page">
    <header class="q-head">
      <h1 class="q-h1">
        Монитор очередей обработки
      </h1>
      <p class="q-sub">
        Живой график длины очередей (backlog = ждут + в работе). Источник —
        <code>GET /api/ops/queues</code> (по сессии оператора); <code>?demo=1</code> —
        превью на синтетических данных. Подробнее — <code>docs/QUEUES.md</code>.
      </p>
    </header>

    <ClientOnly>
      <QueueMonitor
        :fetcher="fetcher"
        title="Очереди обработки"
        :interval-sec="5"
        :max-points="60"
      />
    </ClientOnly>
  </main>
</template>

<style scoped>
.q-page { max-width: 1080px; margin: 0 auto; padding: 24px 16px; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111827; }
.q-head { margin-bottom: 16px; }
.q-h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
.q-sub { margin: 0; color: #6b7280; font-size: 14px; }
.q-sub code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; }
</style>
