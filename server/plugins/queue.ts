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
import { liveDeletionDeps, liveFeedbackPostDeps, liveHandlerDeps, liveTriggerFireDeps, startDeletionWorker, startEventWorker, startFeedbackWorker, startThroughputWorkers, startTriggerWorker } from '../queue/worker'
import { attachWorkerObservability } from '../queue/workerObservability'
import { enqueueFetch } from '../queue/producers'
import { accountsForPolling, buildDemoFetchJobs, cronIntervalMs, demoTickMs, planFetches, pollWindow } from '../queue/cron'
import { clampSaturationThreshold, fetchBacklogSaturation, type FetchQueueCounts } from '../queue/saturation'
import { estimatePollCycle, formatPollCycle, planRequests } from '../queue/pollCapacity'
import { listAllBankAccounts } from '../utils/bankTokenStore'
import { queueRuntimeConfig, envFlag } from '../queue/runtime'
import { keepAliveIntervalMs, runTokenKeepAlive, selectTokensNearExpiry } from '../utils/tokenKeepAlive'
import { runStatementSweep, sweepIntervalMs, type SweptQueue } from '../queue/statementSweep'
import { resolveTombstoneDays, sweepExpiredTombstones } from '../utils/tombstoneSweep'
import { ensureAccessToken } from '../utils/ensureAccessToken'
import { getToken } from '../utils/tokenStore'
import { dbQuery } from '../db/client'
import { withSpan } from '../utils/telemetrySpan'

export default defineNitroPlugin((nitroApp) => {
  if (!queueEnabled()) return
  const role = queueRuntimeConfig()
  // Deps are needed by any worker (throughput OR the event worker); build once.
  const deps = (role.workers || role.cron) ? liveHandlerDeps() : null
  const workers: Worker[] = []

  if (role.workers && deps) {
    workers.push(...startThroughputWorkers(deps, {
      concurrency: role.concurrency,
      fetchRate: role.fetchRate,
      priorFetchRate: role.priorFetchRate,
      priorConcurrency: role.priorConcurrency
    }))
    // Feedback outbox worker (#61) — drains transiently-failed feedback issue posts (N-replica-safe).
    workers.push(startFeedbackWorker(liveFeedbackPostDeps()))
    // Trigger-retry worker (#79) — re-fires missed «деньги пришли» signals with backoff (N-replica-safe).
    workers.push(startTriggerWorker(liveTriggerFireDeps()))
    console.info('[queue] throughput + feedback + trigger workers started (fetch/parse/crm-sync/feedback-post/trigger-fire, concurrency=%d, fetch-rate=%d/%dms; prior-fetch concurrency=%d, rate=%d jobs/%dms)', role.concurrency, role.fetchRate.max, role.fetchRate.duration, role.priorConcurrency, role.priorFetchRate.max, role.priorFetchRate.duration)
  } else if (!role.workers) {
    // Loud: this instance won't drain fetch/parse/crm-sync. A worker container MUST be
    // running (docker-compose.prod.yml `worker`), else webhooks/imports pile up silently
    // (Redis is up ⇒ enqueue succeeds ⇒ no sync fallback). See docs/QUEUES.md, DEPLOY.md.
    console.warn('[queue] QUEUE_WORKERS=0 — this instance does NOT process fetch/parse/crm-sync; a worker container MUST be running or those queues never drain')
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined
  let sweepTimer: ReturnType<typeof setInterval> | undefined
  // Cron runs on exactly ONE instance (QUEUE_CRON=1) — two schedulers would enqueue
  // duplicate fetch jobs (demo uses per-tick ids that don't dedup). The SINGLE `b24-events`
  // worker rides here too, so install/uninstall stay ordered even when `worker` is scaled.
  if (role.cron && deps) {
    workers.push(startEventWorker(deps))
    // Deletion-reconcile worker (§9.2) rides the primary instance too — concurrency 1, per-portal
    // ledger reconciles stay ordered even when `worker` is scaled (same rationale as the event worker).
    workers.push(startDeletionWorker(liveDeletionDeps()))
    console.info('[queue] event + deletion workers + cron scheduler started (primary instance)')
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
    // accounts are connected (A7) — an empty registry enqueues nothing (silent, no per-tick noise).
    //
    // SCALE (marketplace: tens of thousands of connected accounts). The enqueue is IDEMPOTENT —
    // no per-tick `epoch`, so the jobId is stable per (portal, account, window). That is the
    // poller's backpressure: the banks cap requests per OAuth CLIENT (shared by all portals), so a
    // full sweep takes `requests / rate` — much longer than one tick. A per-tick-unique id would
    // therefore stack another full copy of every account each tick and grow Redis without bound;
    // with a stable id a still-pending account is simply not re-added, and a completed job frees
    // its id for the next tick (FETCH_JOB_RETENTION). Re-emitting identical ops downstream is safe
    // (crm-sync dedupes writes by the B24 activity marker). The manual «Опросить сейчас» KEEPS its
    // epoch on purpose — that is an explicit operator-forced refetch, already cooldown-limited.
    // Which providers are swept is POLLABLE_PROVIDERS (cron.ts).
    // DEFAULT OFF (opt-in): this timer drives live bank APIs (Alfa: 100 req/min, global per OAuth
    // client), so it ships wired+tested but does NOT auto-run — flip CRON_REAL_POLL=1 deliberately,
    // so connecting the first account (A7) can't silently start polling.
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
          // Cron root span (#78) — groups the poll's pg scan + Redis enqueues under one trace
          // (otherwise they float as orphan child spans). No-op when telemetry off.
          await withSpan('cron.real-poll', { 'job.queue': 'cron.real-poll' }, async () => {
            const refs = await listAllBankAccounts(dbQuery)
            const byPortal = accountsForPolling(refs)
            if (byPortal.length === 0) return // no connected accounts yet — nothing to do
            const now = new Date()
            const { dateFrom, dateTo } = pollWindow(now, lookback)
            // NO per-tick epoch: the jobId must stay STABLE per (portal, account, window) so this
            // enqueue is idempotent. At marketplace scale a sweep takes far longer than a tick
            // (the bank rate cap is shared by every portal), so a per-tick-unique id would stack a
            // fresh copy of every account each tick and grow the queue without bound. With a stable
            // id, re-adding an account that is still pending is a silent no-op and the completed
            // job frees its id for the next tick — see FETCH_JOB_RETENTION.
            const jobs = planFetches(byPortal, dateFrom, dateTo)
            for (const job of jobs) await enqueueFetch(job)
            // Capacity, not just count: at scale the RATE CAP sets the real cadence, not this timer.
            const cycle = estimatePollCycle(planRequests(byPortal), role.fetchRate.max, role.fetchRate.duration, pollMs)
            console.info('[queue] real poll: planned %d fetch jobs (%s..%s, tick %d min) — %s',
              jobs.length, dateFrom, dateTo, pollMs / 60_000, formatPollCycle(jobs.length, cycle))
            if (cycle.exceedsInterval) {
              console.warn('[queue] poll sweep (%d min) is longer than the tick (%d min) — the bank rate cap sets the real statement freshness, not CRON_INTERVAL_MIN. Queue growth is bounded (stable jobIds dedupe pending accounts); raise CRON_LOOKBACK_DAYS so a slower sweep cannot miss operations (docs/OPERATIONS.md).',
                Math.round(cycle.cycleMs / 60_000), Math.round(pollMs / 60_000))
            }
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
          })
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
          // Cron root span (#78) — groups the keep-alive scan + per-portal refreshes.
          await withSpan('cron.keep-alive', { 'job.queue': 'cron.keep-alive' }, () => runTokenKeepAlive(keepAliveDeps))
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

    // Wall-clock retention sweep for the statement-PII queues (#245, docs/PRIVACY.md). BullMQ's
    // age eviction is lazy (fires only on the NEXT terminal job), so an idle portal's last
    // statement payloads linger past their age. This periodic clean deletes them eagerly —
    // an actual wall-clock guarantee. On by default (privacy posture); opt out via env.
    if (envFlag(process.env.STATEMENT_SWEEP, true)) {
      const sweepDeps = {
        clean: (queue: SweptQueue, graceMs: number, type: 'completed' | 'failed') =>
          getQueue(queue).clean(graceMs, 0, type),
        log: (m: string) => console.info(m),
        warn: (m: string) => console.warn(m)
      }
      const sweepMs = sweepIntervalMs(Number(process.env.STATEMENT_SWEEP_INTERVAL_MIN || 30))
      const tombstoneDays = resolveTombstoneDays(process.env.TOMBSTONE_TTL_DAYS)
      const runSweep = async () => {
        try {
          // Cron root span (#78) — groups the per-queue clean calls under one trace.
          await withSpan('cron.sweep', { 'job.queue': 'cron.sweep' }, async () => {
            await runStatementSweep(sweepDeps)
            // Cap portal_tombstone growth (#77) — one row per permanently-removed portal would
            // otherwise accrue forever. Piggybacks this sweep tick (so STATEMENT_SWEEP=0 also
            // disables it — acceptable: both default ON). Isolated so a failure here can't skip
            // the statement clean.
            try {
              const removed = await sweepExpiredTombstones(dbQuery, tombstoneDays)
              if (removed) console.info('[retention] swept %d expired tombstone(s)', removed)
            } catch (e) {
              console.error('[retention] tombstone sweep failed:', (e as Error)?.message)
            }
          })
        } catch (err) {
          // Per-queue clean failures are isolated inside runStatementSweep; only an unexpected
          // throw reaches here. Never let it crash the cron instance.
          console.error('[queue] statement sweep run failed:', (err as Error)?.message)
        }
      }
      sweepTimer = setInterval(runSweep, sweepMs)
      void runSweep() // once at boot
      console.info('[queue] statement + tombstone retention sweep scheduled (every %d min; tombstone TTL %d d, #245/#77)', sweepMs / 60_000, tombstoneDays)
    }
  } else {
    console.info('[queue] cron + event worker disabled (QUEUE_CRON=0) — they run on the primary instance')
  }

  // Failure/error visibility (#78): without a `failed`/`error` listener an exhausted job failure or a
  // worker-level (Redis) error is silent unless the OTel collector runs (default off). Wire greppable,
  // PII-safe log lines onto EVERY started worker (throughput + event + deletion + feedback + trigger).
  const obsDeps = { error: (m: string) => console.error(m), warn: (m: string) => console.warn(m) }
  for (const w of workers) attachWorkerObservability(w, obsDeps)

  nitroApp.hooks.hook('close', async () => {
    if (timer) clearInterval(timer)
    if (pollTimer) clearInterval(pollTimer)
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    if (sweepTimer) clearInterval(sweepTimer)
    await Promise.all(workers.map(w => w.close()))
    await closeQueues()
  })
})
