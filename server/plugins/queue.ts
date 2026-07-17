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
import { closeQueues, getQueue, queueEnabled } from '../queue/connection'
import { Q_FETCH } from '../queue/topology'
import { liveHandlerDeps, startEventWorker, startThroughputWorkers } from '../queue/worker'
import { enqueueFetch } from '../queue/producers'
import { accountsForPolling, buildDemoFetchJobs, cronIntervalMs, demoTickMs, planFetches, pollWindow } from '../queue/cron'
import { clampSaturationThreshold, fetchBacklogSaturation, type FetchQueueCounts } from '../queue/saturation'
import { listAllBankAccounts } from '../utils/bankTokenStore'
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
    workers.push(...startThroughputWorkers(deps, { concurrency: role.concurrency, fetchRate: role.fetchRate }))
    console.info('[queue] throughput workers started (fetch/parse/crm-sync, concurrency=%d, fetch-rate=%d/%dms)', role.concurrency, role.fetchRate.max, role.fetchRate.duration)
  } else if (!role.workers) {
    // Loud: this instance won't drain fetch/parse/crm-sync. A worker container MUST be
    // running (docker-compose.prod.yml `worker`), else webhooks/imports pile up silently
    // (Redis is up ⇒ enqueue succeeds ⇒ no sync fallback). See docs/QUEUES.md, DEPLOY.md.
    console.warn('[queue] QUEUE_WORKERS=0 — this instance does NOT process fetch/parse/crm-sync; a worker container MUST be running or those queues never drain')
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
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

    // Real bank polling (A10): every CRON_INTERVAL_MIN, enqueue one fetch job per connected
    // bank account (A6 registry over the bank_tokens store) for a rolling window. INERT until
    // accounts are connected (A7) — an empty registry enqueues nothing (silent, no per-tick
    // noise). A fresh `epoch` per tick makes each poll a distinct job that actually re-fetches
    // (see FetchJob.epoch) AND re-runs crm-sync (epoch folds into batchId → jobId); re-emitting
    // identical ops is safe (crm-sync dedupes writes by the B24 marker). Prior is filtered out
    // until A5b (POLLABLE_PROVIDERS).
    // DEFAULT OFF (opt-in): the A8 rate limiter isn't built yet, and this timer drives the live
    // Alfa API (100 req/min, global per-OAuth-client) with only a per-worker BullMQ limiter. So
    // the machinery ships wired+tested but does NOT auto-run — flip CRON_REAL_POLL=1 in the same
    // change that lands A8, so connecting the first account (A7) can't silently start unthrottled
    // polling. Today the registry is empty anyway, so this only guards the future A7 activation.
    if ((process.env.CRON_REAL_POLL ?? '0') === '1') {
      const pollMs = cronIntervalMs(Number(process.env.CRON_INTERVAL_MIN || 5))
      const lookback = Number(process.env.CRON_LOOKBACK_DAYS || 1)
      // A8 saturation signal: the live Alfa poll is capped by a global BullMQ limiter, so a
      // plan that outruns the cap DEFERS fetch jobs (waiting/delayed pile-up) — invisible in
      // the default counters. After each poll, check the bank-fetch backlog and log it
      // EXPLICITLY when it crosses the threshold, so on-call reads "rate-limit saturation"
      // rather than a mystery backlog (docs/OPERATIONS.md). Threshold clamped so an env typo
      // can't silence it. Runs only here (single cron instance) → no duplicate warnings.
      const satThreshold = clampSaturationThreshold(Number(process.env.QUEUE_FETCH_SATURATION_THRESHOLD ?? NaN))
      const poll = async () => {
        try {
          const refs = await listAllBankAccounts(dbQuery)
          const byPortal = accountsForPolling(refs)
          if (byPortal.length === 0) return // no connected accounts yet — nothing to do
          const now = new Date()
          const { dateFrom, dateTo } = pollWindow(now, lookback)
          const jobs = planFetches(byPortal, dateFrom, dateTo, String(now.getTime()))
          for (const job of jobs) await enqueueFetch(job)
          console.info('[queue] real poll: enqueued %d fetch jobs (%s..%s, every %d min)', jobs.length, dateFrom, dateTo, pollMs / 60_000)
          // Best-effort: a counts read must never break the poll (it already enqueued).
          try {
            const counts = await getQueue(Q_FETCH).getJobCounts('waiting', 'delayed') as FetchQueueCounts
            const sat = fetchBacklogSaturation(counts, satThreshold)
            if (sat.over) {
              console.warn('[queue] bank-fetch backlog %d ≥ %d — likely A8 rate-limit saturation (jobs DEFERRED by the global limiter, not stuck); raise QUEUE_FETCH_RATE_* only if Alfa raises its cap (docs/OPERATIONS.md)', sat.backlog, satThreshold)
            }
          } catch (err) {
            console.error('[queue] fetch saturation check failed:', (err as Error)?.message)
          }
        } catch (err) {
          console.error('[queue] real poll tick failed:', (err as Error)?.message)
        }
      }
      pollTimer = setInterval(poll, pollMs)
      void poll() // fire once at boot
      console.info('[queue] real bank poll scheduled (every %d min, inert until accounts connected — A10)', pollMs / 60_000)
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
    if (pollTimer) clearInterval(pollTimer)
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    await Promise.all(workers.map(w => w.close()))
    await closeQueues()
  })
})
