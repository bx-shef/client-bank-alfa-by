<script setup lang="ts">
// Ops-страница: живой график длины очередей BullMQ (QueueMonitor + ECharts).
//
// Источник в проде — GET /api/queues (server-only: guard B24_APPLICATION_TOKEN +
// nginx `deny all`, из браузера портала недостижим). Поэтому здесь по умолчанию —
// ДЕМО-генератор (эволюционирующий снапшот), как и остальной UI на mock-данных до
// backend. Реальное подключение — заменить `demoFetcher` на fetch('/api/queues')
// из операторской среды. См. docs/QUEUES.md.
import { QUEUE_META, type QueueCounts, type QueuesSnapshot } from '~/utils/queueChart'

useHead({ title: 'Очереди — монитор' })

// Демо-состояние: у каждой очереди дрейфующие счётчики, чтобы график «жил».
const state: Record<string, QueueCounts> = {}
for (const q of QUEUE_META) state[q.name] = { waiting: 2, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }

const rnd = (n: number) => Math.floor(Math.random() * (n + 1))

/** Демо-загрузчик: продвигает счётчики (waiting дрейфует, часть уходит в active →
 * completed, изредка failed) и возвращает снапшот той же формы, что GET /api/queues. */
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
        Живой график длины очередей (backlog = ждут + в работе). Данные —
        <strong>демо</strong>; в проде источник — <code>GET /api/queues</code>
        (server-only). Подробнее — <code>docs/QUEUES.md</code>.
      </p>
    </header>

    <QueueMonitor
      :fetcher="demoFetcher"
      title="Очереди (демо)"
      :interval-sec="2"
      :max-points="60"
    />
  </main>
</template>

<style scoped>
.q-page { max-width: 1080px; margin: 0 auto; padding: 24px 16px; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111827; }
.q-head { margin-bottom: 16px; }
.q-h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
.q-sub { margin: 0; color: #6b7280; font-size: 14px; }
.q-sub code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; }
</style>
