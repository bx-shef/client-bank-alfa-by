// Nitro startup plugin: start the BullMQ workers and/or the cron scheduler in this
// instance, gated by the queue role (QUEUE_WORKERS / QUEUE_CRON — see runtime.ts).
// No-op without REDIS_URL (SSG/dev without Redis).
//
// One image, three roles (docs/QUEUES.md «Масштабирование»):
//   - single container (default): workers + cron here — one instance drains queues;
//   - HTTP/primary (QUEUE_WORKERS=0): serves the API + runs the cron;
//   - worker (QUEUE_CRON=0, RUN_MIGRATION=0), scaled to N replicas: all pull from the
//     same Redis, so replicas add throughput. Redis hands each job to exactly one worker.

import type { Worker } from 'bullmq'
import { closeQueues, queueEnabled } from '../queue/connection'
import { liveHandlerDeps, startWorkers } from '../queue/worker'
import { enqueueFetch } from '../queue/producers'
import { buildDemoFetchJobs, demoTickMs } from '../queue/cron'
import { queueRuntimeConfig } from '../queue/runtime'

export default defineNitroPlugin((nitroApp) => {
  if (!queueEnabled()) return
  const role = queueRuntimeConfig()

  let workers: Worker[] = []
  if (role.workers) {
    workers = startWorkers(liveHandlerDeps(), { concurrency: role.concurrency })
    console.info('[queue] started %d workers (concurrency=%d)', workers.length, role.concurrency)
  } else {
    console.info('[queue] workers disabled (QUEUE_WORKERS=0) — jobs drained by worker containers')
  }

  let timer: ReturnType<typeof setInterval> | undefined
  // Cron runs on exactly ONE instance (QUEUE_CRON=1). Two schedulers would enqueue
  // duplicate fetch jobs (demo uses per-tick ids that don't dedup).
  if (role.cron) {
    const demoN = Number(process.env.DEMO_LOAD_N || 0)
    // Demo cadence is SECONDS (DEMO_TICK_SEC, default 5) so the queues visibly "live"
    // on the chart — real polling stays on CRON_INTERVAL_MIN (minutes), but that path
    // is empty until accounts are stored (stage 5).
    const tickMs = demoTickMs(Number(process.env.DEMO_TICK_SEC || 5))
    if (demoN > 0) {
      const tick = async () => {
        try {
          const now = new Date()
          const today = now.toISOString().slice(0, 10)
          // Unique per-tick token so each tick enqueues fresh jobIds (otherwise the
          // deterministic id dedupes ticks within a day into a single no-op run).
          const jobs = buildDemoFetchJobs('demo-portal', demoN, today, String(now.getTime()))
          for (const job of jobs) await enqueueFetch(job)
          console.info('[queue] demo load: enqueued %d fetch jobs (every %d s)', jobs.length, tickMs / 1000)
        } catch (err) {
          console.error('[queue] demo tick failed:', (err as Error)?.message)
        }
      }
      timer = setInterval(tick, tickMs)
      void tick() // fire once at boot so the demo starts immediately
    }
  } else {
    console.info('[queue] cron disabled (QUEUE_CRON=0) — scheduler runs on the primary instance')
  }

  nitroApp.hooks.hook('close', async () => {
    if (timer) clearInterval(timer)
    await Promise.all(workers.map(w => w.close()))
    await closeQueues()
  })
})
