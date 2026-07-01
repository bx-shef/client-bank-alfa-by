// Nitro startup plugin: start the BullMQ workers in-process and, if a load demo
// is enabled, run the cron tick that enqueues synthetic fetch jobs every
// CRON_INTERVAL_MIN. No-op without REDIS_URL (SSG/dev without Redis).
//
// In-process workers are the Phase-2 demo: one backend instance both serves the
// API and drains the queues, so `GET /api/queues` shows load moving. Scale-out
// (a dedicated worker container running startWorkers()) is the next infra step —
// see docs/REFACTOR_PLAN.md.

import { closeQueues, queueEnabled } from '../queue/connection'
import { liveHandlerDeps, startWorkers } from '../queue/worker'
import { enqueueFetch } from '../queue/producers'
import { buildDemoFetchJobs, cronIntervalMs } from '../queue/cron'

export default defineNitroPlugin((nitroApp) => {
  if (!queueEnabled()) return

  const workers = startWorkers(liveHandlerDeps())
  console.info('[queue] started %d workers', workers.length)

  const demoN = Number(process.env.DEMO_LOAD_N || 0)
  const intervalMin = Number(process.env.CRON_INTERVAL_MIN || 5)
  let timer: ReturnType<typeof setInterval> | undefined

  if (demoN > 0) {
    const tick = async () => {
      try {
        const now = new Date()
        const today = now.toISOString().slice(0, 10)
        // Unique per-tick token so each tick enqueues fresh jobIds (otherwise the
        // deterministic id dedupes ticks within a day into a single no-op run).
        const jobs = buildDemoFetchJobs('demo-portal', demoN, today, String(now.getTime()))
        for (const job of jobs) await enqueueFetch(job)
        console.info('[queue] demo load: enqueued %d fetch jobs (every %d min)', jobs.length, intervalMin)
      } catch (err) {
        console.error('[queue] demo tick failed:', (err as Error)?.message)
      }
    }
    timer = setInterval(tick, cronIntervalMs(intervalMin))
    void tick() // fire once at boot so the demo starts immediately
  }

  nitroApp.hooks.hook('close', async () => {
    if (timer) clearInterval(timer)
    await Promise.all(workers.map(w => w.close()))
    await closeQueues()
  })
})
