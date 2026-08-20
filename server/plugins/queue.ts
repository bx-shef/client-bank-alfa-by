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
import { Q_FETCH, Q_FETCH_PRIOR } from '../queue/topology'
import { liveDeletionDeps, liveFeedbackPostDeps, liveHandlerDeps, liveTriggerFireDeps, startDeletionWorker, startEventWorker, startFeedbackWorker, startThroughputWorkers, startTriggerWorker } from '../queue/worker'
import { attachWorkerObservability } from '../queue/workerObservability'
import { enqueueFetch } from '../queue/producers'
import { accountsForPolling, buildDemoFetchJobs, cronIntervalMs, demoTickMs, planFetches, pollWindow } from '../queue/cron'
import { clampSaturationThreshold, fetchBacklogSaturation, type FetchQueueCounts } from '../queue/saturation'
import { estimateProviderCycles, formatPollCycle, REQUESTS_PER_ACCOUNT } from '../queue/pollCapacity'
import { deleteBankToken, listAllBankAccountInfo, listBankAccountInfoForPortal, listAllBankAccounts } from '../utils/bankTokenStore'
import { queueRuntimeConfig, envFlag } from '../queue/runtime'
import { keepAliveIntervalMs, runTokenKeepAlive, selectTokensNearExpiry } from '../utils/tokenKeepAlive'
import { BANK_KEEP_ALIVE_MINUTES, bankKeepAliveIntervalMs } from '../utils/bankTokenKeepAlive'
import { scheduleBankKeepAlive } from '../utils/bankKeepAliveSchedule'
import { runStatementSweep, sweepIntervalMs, type SweptQueue } from '../queue/statementSweep'
import { resolveTombstoneDays, sweepExpiredTombstones } from '../utils/tombstoneSweep'
import { sweepOldBatches } from '../utils/importBatchStore'
import { resolvePendingMaxAgeDays, sweepAbandonedPending } from '../utils/pendingSweep'
import { ensureAccessToken } from '../utils/ensureAccessToken'
import { getToken } from '../utils/tokenStore'
import { dbQuery } from '../db/client'
import { withSpan } from '../utils/telemetrySpan'
import { MAX_FAILED_SCAN } from '../utils/queueHealthRead'
import { recordQueueHealth } from '../utils/queueAlertState'
import { keepAlivePulse, keepAliveStartedAt } from '../utils/keepAliveState'
import { runQueueHealthTick } from '../utils/queueHealthTick'
import { emptyDeliveryState, type DeliveryState } from '../utils/queueAlertDeliver'
import { resolveTelegramConfig, sendTelegramAlert, type AlertFetchFn } from '../utils/telegramAlert'
import type { QueueName } from '../queue/topology'

/** Сколько дней храним итоги ручных загрузок (#417) — переживает вкладку, но не неделю. */
const IMPORT_BATCH_TTL_DAYS = 3

/** How often the queue health check reads the pipeline (#426). Also the resolution of every alert:
 *  a breakage is noticed at most this late, and a recovery announced at most this late. */
const QUEUE_HEALTH_INTERVAL_MS = 5 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  const role = queueRuntimeConfig()
  let bankKeepAliveTimer: ReturnType<typeof setInterval> | undefined
  // ⚠ Каденция вычисляется ЗДЕСЬ и переиспользуется проверкой пульса: возьми она своё число, и
  // оператор, разредивший продление через env, получал бы ложную тревогу на каждом тике.
  const bankKeepAliveMs = bankKeepAliveIntervalMs(Number(process.env.BANK_KEEPALIVE_MINUTES || BANK_KEEP_ALIVE_MINUTES))
  // ⚠ ПРОДЛЕНИЕ БАНКОВСКИХ ТОКЕНОВ — ДО гейта Redis, и это главное в порядке этих строк (#489).
  // Ему нужны Postgres и сам банк; очередь не нужна вовсе. Пока оно стояло после `queueEnabled()`,
  // любой простой Redis тихо уносил с собой банковские подключения — а лечится их смерть не
  // рестартом сервиса, а походом ВЛАДЕЛЬЦА СЧЁТА в интернет-банк.
  //
  // ⚠ И `CRON_REAL_POLL` его тоже не гейтит: тот флаг про «не долбить API выписки», а обновление
  // токена выписку не читает. Связать одно с другим — значит убивать подключение каждый раз, когда
  // опрос ставят на паузу; ровно это и происходило.
  if (role.cron) {
    bankKeepAliveTimer = scheduleBankKeepAlive(process.env.BANK_KEEPALIVE_MINUTES)
  }
  if (!queueEnabled()) {
    console.warn('[queue] Redis не настроен — очереди выключены; продление банк-токенов работает независимо')
    return
  }
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
  let batchSweepTimer: ReturnType<typeof setInterval> | undefined
  let healthTimer: ReturnType<typeof setInterval> | undefined
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
            // PER PROVIDER — each drains from its own queue/limiter, in parallel, so one serial
            // total would charge Prior's ~10× requests against Alfa's budget and misreport both.
            const cycles = estimateProviderCycles(byPortal, provider => (
              provider === 'prior-by'
                // Prior's limiter is in JOBS; convert back to a REQUEST budget for the estimate.
                ? { requests: role.priorFetchRate.max * (REQUESTS_PER_ACCOUNT['prior-by'] ?? 1), durationMs: role.priorFetchRate.duration }
                : { requests: role.fetchRate.max, durationMs: role.fetchRate.duration }
            ), pollMs)
            console.info('[queue] real poll: planned %d fetch jobs (%s..%s, tick %d min) — %s',
              jobs.length, dateFrom, dateTo, pollMs / 60_000,
              cycles.map(c => `${c.provider}: ${formatPollCycle(c.accounts, c.cycle)}`).join(' | '))
            for (const c of cycles) {
              if (!c.cycle.exceedsInterval) continue
              console.warn('[queue] %s poll sweep (%d min) is longer than the tick (%d min) — the bank rate cap sets the real statement freshness for this provider, not CRON_INTERVAL_MIN. Queue growth is bounded (stable jobIds dedupe pending accounts); raise CRON_LOOKBACK_DAYS so a slower sweep cannot miss operations (docs/OPERATIONS.md).',
                c.provider, Math.round(c.cycle.cycleMs / 60_000), Math.round(pollMs / 60_000))
            }
            // Best-effort: a counts read must never break the poll (it already enqueued).
            try {
              // BOTH fetch queues — at scale the SATURATED one is usually Prior (its jobs cost ~10
              // requests each), and sampling only `bank-fetch` would leave that backlog invisible.
              for (const q of [Q_FETCH, Q_FETCH_PRIOR] as const) {
                const counts = await getQueue(q).getJobCounts('waiting', 'delayed') as FetchQueueCounts
                const sat = fetchBacklogSaturation(counts, satThreshold)
                if (sat.over) {
                  const knob = q === Q_FETCH_PRIOR ? 'QUEUE_PRIOR_RATE_*' : 'QUEUE_FETCH_RATE_*'
                  console.warn('[queue] %s backlog %d ≥ %d — likely rate-limit saturation (jobs DEFERRED by that queue\'s limiter, not stuck); raise %s only if the bank raises its cap (docs/OPERATIONS.md)', q, sat.backlog, satThreshold, knob)
                }
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

    // ⚠ BANK token keep-alive (#488/#489) здесь БОЛЬШЕ НЕТ — он заведён ВЫШЕ гейта Redis, до
    // `queueEnabled()`. Пока он жил тут, простой Redis уносил с собой банковские подключения:
    // банку до нашей очереди дела нет, а цена промаха платится не сервисом, а владельцем счёта —
    // походом в интернет-банк. См. `scheduleBankKeepAlive` в server/utils/bankKeepAliveSchedule.ts.

    // Ретенция итогов ручных загрузок (#417). ВНЕ флага `STATEMENT_SWEEP`: строка несёт имя файла
    // клиента, то есть это чистка ПДн, и ставить её в зависимость от тумблера чистки ОЧЕРЕДЕЙ
    // значило бы, что документированный opt-out по очередям молча отключает не относящуюся к нему
    // ретенцию, а записи копились бы бессрочно.
    const runBatchSweep = async () => {
      try {
        await sweepOldBatches(dbQuery, IMPORT_BATCH_TTL_DAYS)
      } catch (e) {
        console.error('[retention] import_batch sweep failed:', (e as Error)?.message)
      }
    }
    batchSweepTimer = setInterval(runBatchSweep, 6 * 60 * 60 * 1000)
    void runBatchSweep()

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
      const pendingMaxAgeDays = resolvePendingMaxAgeDays(process.env.PENDING_MAX_AGE_DAYS)
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
            // ⚠ Как и тумбстоуны, свип висит на флаге `STATEMENT_SWEEP` — то есть `=0` гасит и
            // чистку банковских кредов, хотя флаг заведён про payload'ы выписки. Осознанно: оба
            // default ON, а второй таймер ради одного DELETE в полчаса — лишняя механика.
            // Брошенные подключения без счёта (#485): их не удалял никто, а копятся они гроздьями —
            // каждый повтор connect'а заводит НОВУЮ строку (nonce всякий раз другой). Изолировано
            // от соседей по той же причине, что и тумбстоуны: сбой здесь не должен отменять их.
            try {
              const removed = await sweepAbandonedPending({
                now: Date.now,
                list: () => listAllBankAccountInfo(dbQuery),
                // ⚠ Тот же лок, что у обновления токена и выбора счёта (#509), и перечит ВНУТРИ
                // него: keep-alive намеренно продлевает и ожидающие подключения, и без перечита
                // свип сносил бы строку, которую тот только что доказал живой у банка.
                withLock: withAdvisoryLock,
                reread: async (q, memberId, provider, accountKey) =>
                  (await listBankAccountInfoForPortal(q, memberId))
                    .find(r => r.provider === provider && r.accountKey === accountKey) ?? null,
                remove: (q, memberId, provider, accountKey) => deleteBankToken(q, memberId, provider, accountKey),
                maxAgeDays: pendingMaxAgeDays
              })
              if (removed) console.info('[retention] swept %d abandoned pending connection(s)', removed)
            } catch (e) {
              console.error('[retention] pending sweep failed:', (e as Error)?.message)
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
      console.info('[queue] statement + tombstone + pending-connection retention sweep scheduled (every %d min; tombstone TTL %d d, #245/#77)', sweepMs / 60_000, tombstoneDays)
    }

    // ── Queue health check + push alerting (#426) ────────────────────────────────────────────
    // `/queues` and the `[queue-job-failed]` logs both require somebody to already be looking,
    // which is exactly what an alert is for. This is the first channel that knocks by itself.
    // Cron instance only: one voice, not one per scaled worker replica.
    //
    // The tick itself lives in `runQueueHealthTick` (server/utils/queueHealthTick.ts) so it is
    // testable — a plugin is a startup side-effect and nothing in it can be asserted. What stays
    // here is what belongs to a plugin: the timer, the process-wide state, and the live bindings.
    let healthRunning = false
    // What has already been said. In memory on purpose: it lives in the same process as the check,
    // and after a restart re-announcing an ongoing outage once is the RIGHT behaviour anyway — a
    // backend that keeps restarting is itself worth knowing about.
    let delivery: DeliveryState = emptyDeliveryState()
    // Resolved once: the channel is env-driven, and an unset one is a normal deployment.
    // Null → alerts stay in the log and on /queues, exactly as before.
    const telegram = resolveTelegramConfig(process.env)
    const queuesUrl = (() => {
      const base = String(process.env.NUXT_PUBLIC_SITE_URL ?? '').trim().replace(/\/+$/, '')
      return /^https:\/\//i.test(base) ? `${base}/queues` : null
    })()
    console.info(telegram
      ? '[queue] alert channel: telegram'
      : '[queue] alert channel OFF — alerts go to the log and /queues only (set TELEGRAM_ALERT_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID)')

    const runHealthCheck = async () => {
      // Ticks must not overlap. ⚠ The guard is held across SENDING too, not just the read: a slow
      // Telegram (10s per message × up to two alerts per queue) can outlast the 5-minute interval,
      // and a second tick starting mid-send would see episodes not yet marked as announced and
      // push the very same message again — duplicating precisely during the outage that makes the
      // channel slow in the first place.
      if (healthRunning) return
      healthRunning = true
      try {
        const result = await withSpan('cron.queue-health', { 'job.queue': 'cron.queue-health' }, () =>
          runQueueHealthTick(delivery, {
            reader: {
              pending: async (name: QueueName) => await getQueue(name).getJobs(['waiting', 'active', 'delayed']),
              failed: async (name: QueueName) => await getQueue(name).getFailed(0, MAX_FAILED_SCAN - 1)
            },
            now: () => Date.now(),
            push: async (text: string) => {
              if (!telegram) return false
              try {
                const r = await sendTelegramAlert(telegram, text, globalThis.fetch as unknown as AlertFetchFn)
                // Status only — the URL carries the bot token, so nothing else is loggable.
                if (!r.ok) console.error(`[queue-alert] telegram send failed: status=${r.status}`)
                return r.ok
              } catch {
                return false // alerting must never take the cron instance down
              }
            },
            record: recordQueueHealth,
            warn: (m: string) => console.warn(m),
            error: (m: string) => console.error(m),
            queuesUrl,
            // Умирающие банковские подключения — в тот же канал (#497 §3). Карточку на `/queues`
            // надо ОТКРЫТЬ, а refresh Альфы умирает под утро (#488), когда на экран никто не
            // смотрит: пул-дашборд закрыть критерий «МЫ видим его проблемы» не может.
            bankRows: () => listAllBankAccountInfo(dbQuery),
            // Пульс продления (#504). Каденция берётся ТА ЖЕ, что у самого таймера, — иначе
            // оператор, разредивший продление через env, получал бы ложную тревогу на каждом тике.
            keepAlive: () => ({ pulse: keepAlivePulse(), intervalMs: bankKeepAliveMs, startedAtMs: keepAliveStartedAt() })
          }))
        delivery = result.state
      } catch (err) {
        // runQueueHealthTick swallows its own failures; only a bug in the bindings reaches here.
        console.error('[queue] health check failed:', (err as Error)?.message)
      } finally {
        healthRunning = false
      }
    }
    healthTimer = setInterval(() => void runHealthCheck(), QUEUE_HEALTH_INTERVAL_MS)
    void runHealthCheck()
    console.info('[queue] health check scheduled (every %d min, #426)', QUEUE_HEALTH_INTERVAL_MS / 60_000)
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
    if (bankKeepAliveTimer) clearInterval(bankKeepAliveTimer)
    if (sweepTimer) clearInterval(sweepTimer)
    if (batchSweepTimer) clearInterval(batchSweepTimer)
    if (healthTimer) clearInterval(healthTimer)
    await Promise.all(workers.map(w => w.close()))
    await closeQueues()
  })
})
