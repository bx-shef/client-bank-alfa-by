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
import { liveHandlerDeps, startEventWorker, startThroughputWorkers } from '../queue/worker'
import { enqueueFetch } from '../queue/producers'
import { buildDemoFetchJobs, demoTickMs } from '../queue/cron'
import { queueRuntimeConfig } from '../queue/runtime'
import { keepAliveIntervalMs, runTokenKeepAlive, selectTokensNearExpiry } from '../utils/tokenKeepAlive'
import { ensureAccessToken } from '../utils/ensureAccessToken'
import { getToken } from '../utils/tokenStore'
import { dbQuery } from '../db/client'

export default defineNitroPlugin((nitroApp) => {
  if (!queueEnabled()) return
  const role = queueRuntimeConfig()
  // Deps are needed by any worker (throughput OR the event worker); build once.
  const deps = (role.workers || role.cron) ? liveHandlerDeps() : null
  const workers: Worker[] = []

  if (role.workers && deps) {
    workers.push(...startThroughputWorkers(deps, { concurrency: role.concurrency }))
    console.info('[queue] throughput workers started (fetch/parse/crm-sync, concurrency=%d)', role.concurrency)
  } else if (!role.workers) {
    // Loud: this instance won't drain fetch/parse/crm-sync. A worker container MUST be
    // running (docker-compose.prod.yml `worker`), else webhooks/imports pile up silently
    // (Redis is up ⇒ enqueue succeeds ⇒ no sync fallback). See docs/QUEUES.md, DEPLOY.md.
    console.warn('[queue] QUEUE_WORKERS=0 — this instance does NOT process fetch/parse/crm-sync; a worker container MUST be running or those queues never drain')
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined
  // Cron runs on exactly ONE instance (QUEUE_CRON=1) — two schedulers would enqueue
  // duplicate fetch jobs (demo uses per-tick ids that don't dedup). The SINGLE `b24-events`
  // worker rides here too, so install/uninstall stay ordered even when `worker` is scaled.
  if (role.cron && deps) {
    workers.push(startEventWorker(deps))
    console.info('[queue] event worker + cron scheduler started (primary instance)')
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

    // Proactive OAuth keep-alive (#175): refresh_token lives ~180d; an installed-but-idle
    // portal makes no REST calls, so the lazy refresh never fires and its token silently
    // dies. Once a day, refresh ONLY portals within ~3d of refresh-expiry. Needs the app
    // creds (can't refresh without them) — without them, skip loudly (lazy path warns too).
    const hasOAuthCreds = !!(process.env.B24_CLIENT_ID?.trim() && process.env.B24_CLIENT_SECRET?.trim())
    if (hasOAuthCreds) {
      const keepAliveDeps = {
        now: Date.now,
        selectNearExpiry: (nowMs: number) => selectTokensNearExpiry(dbQuery, nowMs),
        getToken: (memberId: string) => getToken(dbQuery, memberId),
        ensureAccessToken: (token: Parameters<typeof ensureAccessToken>[0]) => ensureAccessToken(token),
        log: (m: string) => console.info(m),
        warn: (m: string) => console.warn(m)
      }
      const keepAliveMs = keepAliveIntervalMs(Number(process.env.TOKEN_KEEPALIVE_HOURS || 24))
      const runKeepAlive = async () => {
        try {
          await runTokenKeepAlive(keepAliveDeps)
        } catch (err) {
          // Only a failure of the initial SELECT reaches here (per-portal failures are
          // isolated inside runTokenKeepAlive). Never let it crash the cron instance.
          console.error('[queue] token keep-alive run failed:', (err as Error)?.message)
        }
      }
      keepAliveTimer = setInterval(runKeepAlive, keepAliveMs)
      void runKeepAlive() // once at boot (cheap: a range scan + refresh of only near-expiry portals)
      console.info('[queue] token keep-alive scheduled (every %d h, #175)', keepAliveMs / 3_600_000)
    } else {
      console.warn('[queue] token keep-alive disabled — B24_CLIENT_ID/SECRET unset (idle portals may lose auth on day 180)')
    }
  } else {
    console.info('[queue] cron + event worker disabled (QUEUE_CRON=0) — they run on the primary instance')
  }

  nitroApp.hooks.hook('close', async () => {
    if (timer) clearInterval(timer)
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    await Promise.all(workers.map(w => w.close()))
    await closeQueues()
  })
})
