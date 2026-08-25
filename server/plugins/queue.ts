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
import { randomUUID } from 'node:crypto'
import { startWorkerBeat } from '../utils/workerBeat'
import { useServerLogger } from '../utils/serverLogger'
import { closeQueues, countLiveWorkers, getQueue, queueEnabled } from '../queue/connection'
import { Q_FETCH, Q_FETCH_PRIOR } from '../queue/topology'
import { liveActivityBindDeps, liveDeletionDeps, liveFeedbackPostDeps, liveHandlerDeps, liveRegistryWriteDeps, liveTriggerFireDeps, startBindingsWorker, startDeletionWorker, startEventWorker, startFeedbackWorker, startRegistryWorker, startThroughputWorkers, startTriggerWorker } from '../queue/worker'
import { attachWorkerObservability } from '../queue/workerObservability'
import { enqueueFetch } from '../queue/producers'
import { accountsForPolling, buildDemoFetchJobs, cronIntervalMs, demoTickMs, isPollableAccount, planFetches, pollWindow } from '../queue/cron'
import { pickAccountPollers, sharedAccountsLogLine } from '../../app/utils/accountSharing'
import { clampSaturationThreshold, fetchBacklogSaturation, type FetchQueueCounts } from '../queue/saturation'
import { estimateProviderCycles, formatPollCycle, providerRequestBudget } from '../queue/pollCapacity'
import { deleteBankToken, deleteBankTokenById, deleteBankTokensForPortal, listAllBankAccountInfo, listBankAccountInfoForPortal } from '../utils/bankTokenStore'
import { queueRuntimeConfig, envFlag } from '../queue/runtime'
import { keepAliveIntervalMs, runTokenKeepAlive, selectTokensNearExpiry } from '../utils/tokenKeepAlive'
import { BANK_KEEP_ALIVE_MINUTES, bankKeepAliveIntervalMs } from '../utils/bankTokenKeepAlive'
import { scheduleBankKeepAlive } from '../utils/bankKeepAliveSchedule'
import { runStatementSweep, sweepIntervalMs, type SweptQueue } from '../queue/statementSweep'
import { resolveTombstoneDays, sweepExpiredTombstones } from '../utils/tombstoneSweep'
import { runPortalReaper } from '../utils/portalReaperRun'
import { REAP_MIN_INTERVAL_MS, resolveReapDays } from '../../app/utils/portalReaper'
import { resolveBankReapDays } from '../../app/utils/bankReaper'
import { runBankReaper } from '../utils/bankReaperRun'
import { claimBankReapSlot } from '../utils/bankReaperSchedule'
import { claimSubscriptionCutoffSlot } from '../utils/subscriptionCutoffSchedule'
import { runSubscriptionCutoff } from '../utils/subscriptionCutoffRun'
import { probeSubscriptionVia } from '../utils/subscriptionProbe'
import { livePortalSdkCall } from '../utils/liveDeps'
import { SUBSCRIPTION_CUTOFF_DAYS } from '../../app/utils/portalSubscription'
import { claimReapSlot } from '../utils/portalReaperSchedule'
import {
  clearSubscriptionEnded, countPortals, countRevokedPortals, countSubscriptionCutoff,
  selectReapablePortals, selectSubscriptionCutoff, getToken
} from '../utils/tokenStore'
import { sweepOldBatches } from '../utils/importBatchStore'
import { resolvePendingMaxAgeDays, sweepAbandonedPending } from '../utils/pendingSweep'
import { ensureAccessToken } from '../utils/ensureAccessToken'
import { dbQuery } from '../db/client'
import { withSpan } from '../utils/telemetrySpan'
import { MAX_FAILED_SCAN } from '../utils/queueHealthRead'
import { recordAlertChannelConfigured, recordAlertDelivery, recordQueueHealth } from '../utils/queueAlertState'
import { keepAlivePulse, keepAliveStartedAt } from '../utils/keepAliveState'
import { runQueueHealthTick } from '../utils/queueHealthTick'
import { emptyDeliveryState, type DeliveryState } from '../utils/queueAlertDeliver'
import { resolveTelegramConfig, sendTelegramAlert, type AlertFetchFn } from '../utils/telegramAlert'
import type { QueueName } from '../queue/topology'

// Каналы этого модуля. Имена — те же маркеры, что уже грепает рантбук и `prod-doctor.sh` (#529).
const log = useServerLogger('queue')
const retention = useServerLogger('retention')
const alert = useServerLogger('queue-alert')

/** Сколько дней храним итоги ручных загрузок (#417) — переживает вкладку, но не неделю. */
const IMPORT_BATCH_TTL_DAYS = 3

/** How often the queue health check reads the pipeline (#426). Also the resolution of every alert:
 *  a breakage is noticed at most this late, and a recovery announced at most this late. */
const QUEUE_HEALTH_INTERVAL_MS = 5 * 60 * 1000

export default defineNitroPlugin((nitroApp) => {
  // ⚠ Во время статического пререндера НИЧЕГО не заводим (та же конвенция, что у `envCheck.ts`).
  // Причина не косметическая: живой `setInterval` НЕ ДАЁТ процессу завершиться, и `nuxt generate`
  // виснет НАВСЕГДА уже ПОСЛЕ того, как напечатал «Generated public .output/public» — то есть
  // выглядит успешной сборкой, которая просто не заканчивается. Раньше это было закрыто случайно:
  // продление стояло за гейтом Redis, а Redis на сборке нет. Вынеся его из-под гейта (#489), я эту
  // случайную защиту снял и сломал сборку — CI поймал, локальный `check-app.sh` нет, потому что
  // `pnpm generate` в него не входил.
  if (import.meta.prerender) return
  const role = queueRuntimeConfig()
  let bankKeepAliveTimer: ReturnType<typeof setInterval> | undefined
  // Момент старта процесса — для отсрочки тревоги «нет воркеров» на холодном старте (#466).
  const processStartedAt = Date.now()
  // ⚠ Объявлен ЗДЕСЬ, а не внутри блока воркеров: `unref()` лишь не даёт таймеру единолично
  // удерживать процесс, но НЕ отменяет его. Не сняв таймер в `close`, мы даём удару сработать уже
  // после `closeQueues()` — а он через `getQueue` пересоздаст очередь и НОВОЕ соединение с Redis,
  // которое никто уже не закроет. Остальные шесть таймеров файла сняты именно поэтому.
  let beatTimer: ReturnType<typeof setInterval> | undefined
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
    log.warning('Redis не настроен — очереди выключены; продление банк-токенов работает независимо')
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
    // Дозапись в CRM (#578/#585) — реестр платежей и привязки дела, не удавшиеся синхронно.
    // ⚠ Обе безопасны на N репликах: запись реестра идемпотентна по маркеру операции, а привязки
    // воркер ставит только недостающие, прочитав `binding.list`.
    workers.push(startRegistryWorker(liveRegistryWriteDeps()))
    workers.push(startBindingsWorker(liveActivityBindDeps()))
    log.info(`throughput + feedback + trigger + deferred-write workers started (fetch/parse/crm-sync/feedback-post/trigger-fire/registry-write/activity-bind, concurrency=${role.concurrency}, fetch-rate=${role.fetchRate.max} jobs/${role.fetchRate.duration}ms; prior-fetch concurrency=${role.priorConcurrency}, rate=${role.priorFetchRate.max} jobs/${role.priorFetchRate.duration}ms)`)

    // Пульс воркера (#466 §1). Без него полностью мёртвый воркер на ТИХОМ портале выглядит
    // здоровым: все правила здоровья выведены из наличия застрявшей работы, а её нет.
    //
    // ⚠ Идентификатор — СЛУЧАЙНЫЙ на процесс, а не производный от hostname/pid. Реплики одного
    // образа живут каждая в своём PID-неймспейсе, поэтому `process.pid` у них совпадает буквально,
    // а `HOSTNAME` docker проставляет неявно — его нет в compose, и гард паритета env справедливо
    // на это ругается. Совпавшие ключи схлопнули бы N живых воркеров в один и спрятали смерть
    // остальных — то есть сломали бы ровно то, ради чего пульс заведён.
    //
    // ⚠ Новый id на каждый рестарт — не проблема, а свойство: старый ключ истечёт сам по TTL, и
    // перезапущенный воркер не наследует чужую отметку.
    // Пульс воркера (#466 §1) — планировщик вынесен, чтобы его можно было ПРОВЕРИТЬ вызовом:
    // внутри плагина таймер можно было завести на пустой колбэк, и весь набор оставался зелёным.
    //
    // ⚠ Идентификатор СЛУЧАЙНЫЙ на процесс, не производный от pid/hostname: реплики одного образа
    // живут каждая в своём PID-неймспейсе (`process.pid` совпадает буквально), а `HOSTNAME` docker
    // проставляет неявно — его нет в compose, и гард паритета env на это справедливо ругается.
    // Совпавшие ключи схлопнули бы N живых воркеров в один и спрятали смерть остальных.
    beatTimer = startWorkerBeat(randomUUID(), {
      running: () => workers.some(w => w.isRunning() && !w.isPaused()),
      warn: m => log.warning(m)
    })
  } else if (!role.workers) {
    // Loud: this instance won't drain fetch/parse/crm-sync. A worker container MUST be
    // running (docker-compose.prod.yml `worker`), else webhooks/imports pile up silently
    // (Redis is up ⇒ enqueue succeeds ⇒ no sync fallback). See docs/QUEUES.md, DEPLOY.md.
    log.warning('QUEUE_WORKERS=0 — this instance does NOT process fetch/parse/crm-sync; a worker container MUST be running or those queues never drain')
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
    log.info('event + deletion workers + cron scheduler started (primary instance)')
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
          log.info(`demo load: enqueued ${jobs.length} fetch jobs (every ${tickMs / 1000} s)`)
        } catch (err) {
          log.error(`demo tick failed: ${(err as Error)?.message}`)
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
            // ⚠ Читаем ПОЛНЫЕ строки, а не короткие ссылки: выбор поллера у совместного счёта
            // (#615) смотрит на свежесть подключения, а её в `BankAccountRef` нет.
            const rows = await listAllBankAccountInfo(dbQuery)
            // Один счёт — ОДИН опрос (#615). До этого каждый портал опрашивал банк своим
            // подключением, и они убивали refresh друг другу: Альфа ротирует токен при каждом
            // обновлении, а лок берётся пер-портально. Это и был механизм ежедневной смерти (#488).
            const pollable = rows.filter(isPollableAccount)
            const pollers = pickAccountPollers(pollable, Date.now())
            const shareNote = sharedAccountsLogLine(pollable.length, pollers.length)
            if (shareNote) log.info(`[fetch] ${shareNote}`)
            const byPortal = accountsForPolling(pollers)
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
            // ⚠ BOTH limiters are in JOBS now (#561 put Alfa's on the same footing as Prior's), so
            // both branches must convert back to REQUESTS. Reading `fetchRate.max` raw here made the
            // Alfa sweep estimate exactly `REQUESTS_PER_ACCOUNT` times too long — which does not
            // throttle anything (that path never sees this number) but prints a doubled sweep and
            // trips `exceedsInterval` early, telling the operator to raise CRON_LOOKBACK_DAYS for a
            // fleet nowhere near the cap. One helper for both so a third provider cannot forget.
            const cycles = estimateProviderCycles(byPortal, provider => (
              provider === 'prior-by'
                ? providerRequestBudget(provider, role.priorFetchRate)
                : providerRequestBudget(provider, role.fetchRate)
            ), pollMs)
            log.info(`real poll: planned ${jobs.length} fetch jobs (${dateFrom}..${dateTo}, tick ${pollMs / 60_000} min) — ${cycles.map(c => `${c.provider}: ${formatPollCycle(c.accounts, c.cycle)}`).join(' | ')}`)
            for (const c of cycles) {
              if (!c.cycle.exceedsInterval) continue
              log.warning(`${c.provider} poll sweep (${Math.round(c.cycle.cycleMs / 60_000)} min) is longer than the tick (${Math.round(pollMs / 60_000)} min) — the bank rate cap sets the real statement freshness for this provider, not CRON_INTERVAL_MIN. Queue growth is bounded (stable jobIds dedupe pending accounts); raise CRON_LOOKBACK_DAYS so a slower sweep cannot miss operations (docs/OPERATIONS.md).`)
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
                  log.warning(`${q} backlog ${sat.backlog} ≥ ${satThreshold} — likely rate-limit saturation (jobs DEFERRED by that queue's limiter, not stuck); raise ${knob} only if the bank raises its cap (docs/OPERATIONS.md)`)
                }
              }
            } catch (err) {
              log.error(`fetch saturation check failed: ${(err as Error)?.message}`)
            }
          })
        } catch (err) {
          log.error(`real poll tick failed: ${(err as Error)?.message}`)
        }
      }
      pollTimer = setInterval(poll, pollMs)
      void poll() // fire once at boot
      log.info(`real bank poll scheduled (every ${pollMs / 60_000} min, inert until accounts connected — A10)`)
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
        log: (m: string) => log.info(m),
        warn: (m: string) => log.warning(m)
      }
      const keepAliveMs = keepAliveIntervalMs(Number(process.env.TOKEN_KEEPALIVE_HOURS || 24))
      const runKeepAlive = async () => {
        try {
          // Cron root span (#78) — groups the keep-alive scan + per-portal refreshes.
          await withSpan('cron.keep-alive', { 'job.queue': 'cron.keep-alive' }, () => runTokenKeepAlive(keepAliveDeps))
        } catch (err) {
          // Only a failure of the initial SELECT reaches here (per-portal failures are
          // isolated inside runTokenKeepAlive). Never let it crash the cron instance.
          log.error(`token keep-alive run failed: ${(err as Error)?.message}`)
        }
      }
      keepAliveTimer = setInterval(runKeepAlive, keepAliveMs)
      void runKeepAlive() // once at boot (cheap: a range scan + refresh of only near-expiry portals)
      log.info(`token keep-alive scheduled (every ${keepAliveMs / 3_600_000} h, #175)`)
    } else {
      log.warning('token keep-alive disabled — B24_CLIENT_ID/SECRET unset (idle portals may lose auth on day 180)')
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
        retention.error(`import_batch sweep failed: ${(e as Error)?.message}`)
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
        log: (m: string) => log.info(m),
        warn: (m: string) => log.warning(m)
      }
      const sweepMs = sweepIntervalMs(Number(process.env.STATEMENT_SWEEP_INTERVAL_MIN || 30))
      const tombstoneDays = resolveTombstoneDays(process.env.TOMBSTONE_TTL_DAYS)
      const pendingMaxAgeDays = resolvePendingMaxAgeDays(process.env.PENDING_MAX_AGE_DAYS)
      const reapDays = resolveReapDays(process.env.PORTAL_REAP_DAYS)
      const bankReapDays = resolveBankReapDays(process.env.BANK_REAP_DAYS)
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
              if (removed) retention.info(`swept ${removed} expired tombstone(s)`)
            } catch (e) {
              retention.error(`tombstone sweep failed: ${(e as Error)?.message}`)
            }
            // Уборщик порталов с мёртвым грантом (#574). Изолирован по той же причине, что соседи:
            // отказ здесь не должен отменить чистку выписок.
            //
            // ⚠ Висит на ТОМ ЖЕ тике, что и остальные свипы, а не на своём таймере — и это не
            // экономия. Второй таймер означал бы второе состояние «когда последний раз отработал»
            // и второй способ незаметно не отработать, а данные, за которыми он ходит, меняются
            // раз в сутки.
            // ⚠ ЖИВЁТ ПОД ДВУМЯ ЧУЖИМИ ГЕЙТАМИ, и это осознанный размен, а не недосмотр. Блок
            // стоит внутри `STATEMENT_SWEEP` и ниже `queueEnabled()`, хотя уборщику нужен только
            // Postgres: без Redis и при `STATEMENT_SWEEP=0` он не отработает вовсе, и строки
            // `[retention]` не будет — снаружи неотличимо от «кандидатов нет». Отдельный таймер
            // (как у `scheduleBankKeepAlive`, #489) не заведён потому, что отказ здесь фейлит
            // БЕЗОПАСНО: не отработали — никого не стёрли, а пометку ставят другие пути, которые
            // под этими гейтами не сидят. Обратная ошибка (стереть лишнего) необратима, эта — нет.
            // ⚠ Но молчать об этом нельзя: `PORTAL_REAP_ENABLED=1` без Redis не делает НИЧЕГО.
            // Сказано и в `.env.example`, и в `QUEUES.md`.
            //
            // ⚠ СВОЯ каденция, и держит её АРЕНДА В БАЗЕ, а не память процесса: `runSweep` зовётся
            // сразу на старте, поэтому метка в памяти разрешала бы прогон на КАЖДОМ рестарте, и
            // crash-loop выкосил бы флот по три портала за перезапуск. Разбор — `portalReaperSchedule.ts`.
            if (await claimReapSlot(dbQuery, REAP_MIN_INTERVAL_MS / 1000, randomUUID())) {
              try {
                await runPortalReaper({
                  now: Date.now,
                  countRevoked: beforeMs => countRevokedPortals(dbQuery, beforeMs),
                  countPortals: () => countPortals(dbQuery),
                  selectReapable: (beforeMs, limit) => selectReapablePortals(dbQuery, beforeMs, limit),
                  // ⚠ Удаление по умолчанию ВЫКЛЮЧЕНО. Пометка идёт всегда — она безвредна и делает
                  // проблему видимой; необратимое стирание владелец включает осознанно, увидев на
                  // `/queues`, кого именно уборщик считает мёртвым.
                  // `envFlag`, а не `=== '1'`: во всём этом файле булевы читаются им, и
                  // `PORTAL_REAP_ENABLED=true` иначе молча означал бы «выключено».
                  reapEnabled: envFlag(process.env.PORTAL_REAP_ENABLED, false),
                  // ⚠ ТОТ ЖЕ путь, что у штатного `ONAPPUNINSTALL`: своя «облегчённая» чистка была
                  // бы вторым списком того, что надо удалить, и он разошёлся бы с первым — а
                  // недоудалённые банковские креды это ровно то, ради чего уборщик написан.
                  // ⚠ БРОСАЕМ, а не молча выходим, если `deps` нет: `runPortalReaper` считает
                  // успехом любой не-бросок, поэтому тихий выход дал бы в логе «портал стёрт» о
                  // портале, которого никто не трогал — ложь опаснее отказа.
                  deletePortal: async (memberId, eventTs) => {
                    if (!deps) throw new Error('portal reaper: deps unavailable, refusing to report a deletion that did not happen')
                    await deps.deletePortal(memberId, eventTs)
                  },
                  log: (m: string) => retention.info(m),
                  warn: (m: string) => retention.warning(m)
                }, reapDays)
              } catch (e) {
                retention.error(`portal reaper failed: ${(e as Error)?.message}`)
              }
            }
            // Мёртвые банк-подключения у ЖИВОГО портала (#599, хвост #574). Стирает ОДНУ строку, а
            // не портал; БЕЗ флага (клиентов нет), но с теми же предохранителями. Своя аренда —
            // отдельный ключ от портального уборщика (разные операции). Тот же размен по гейтам
            // `STATEMENT_SWEEP`/`queueEnabled`, что и у соседей: отказ здесь фейлит БЕЗОПАСНО (не
            // отработали — никого не стёрли), а пометку о нездоровье ставят другие пути.
            if (await claimBankReapSlot(dbQuery, REAP_MIN_INTERVAL_MS / 1000, randomUUID())) {
              try {
                await runBankReaper({
                  now: Date.now,
                  listAccounts: () => listAllBankAccountInfo(dbQuery),
                  remove: (memberId, id, expectedAccountKey) => deleteBankTokenById(dbQuery, memberId, id, expectedAccountKey),
                  log: (m: string) => retention.info(`[bank-reap] ${m}`),
                  warn: (m: string) => retention.warning(`[bank-reap] ${m}`)
                }, bankReapDays)
              } catch (e) {
                retention.error(`bank reaper failed: ${(e as Error)?.message}`)
              }
            }
            // Портал без подписки на REST (#614). Отключаем БАНК, а не портал: приложение
            // установлено законно, кончилась оплата REST. Пока висит — портал жжёт лимит банка и
            // гоняется за ротацией refresh с другими порталами, у которых тот же счёт (#615), а
            // записать не может ничего. Своя аренда — отдельный ключ от обоих уборщиков.
            if (await claimSubscriptionCutoffSlot(dbQuery, REAP_MIN_INTERVAL_MS / 1000, randomUUID())) {
              try {
                await runSubscriptionCutoff({
                  now: Date.now,
                  countDue: beforeMs => countSubscriptionCutoff(dbQuery, beforeMs),
                  countPortals: () => countPortals(dbQuery),
                  selectDue: (beforeMs, limit) => selectSubscriptionCutoff(dbQuery, beforeMs, limit),
                  disconnectBanks: memberId => deleteBankTokensForPortal(dbQuery, memberId),
                  // ⚠ Живой перезапрос ПЕРЕД необратимым шагом: метку снимает только удачный
                  // прогон crm-sync, а на тихом счёте его не бывает вовсе — без этой проверки
                  // автомат отключил бы банк у портала, оплатившего подписку на второй день.
                  probeSubscription: async memberId => probeSubscriptionVia(await livePortalSdkCall(memberId)),
                  clearMark: memberId => clearSubscriptionEnded(dbQuery, memberId),
                  log: (m: string) => retention.info(`[sub-cutoff] ${m}`),
                  warn: (m: string) => retention.warning(`[sub-cutoff] ${m}`)
                }, SUBSCRIPTION_CUTOFF_DAYS)
              } catch (e) {
                retention.error(`subscription cutoff failed: ${(e as Error)?.message}`)
              }
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
              if (removed) retention.info(`swept ${removed} abandoned pending connection(s)`)
            } catch (e) {
              retention.error(`pending sweep failed: ${(e as Error)?.message}`)
            }
          })
        } catch (err) {
          // Per-queue clean failures are isolated inside runStatementSweep; only an unexpected
          // throw reaches here. Never let it crash the cron instance.
          log.error(`statement sweep run failed: ${(err as Error)?.message}`)
        }
      }
      sweepTimer = setInterval(runSweep, sweepMs)
      void runSweep() // once at boot
      log.info(`statement + tombstone + pending-connection retention sweep scheduled (every ${sweepMs / 60_000} min; tombstone TTL ${tombstoneDays} d, #245/#77)`)
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
    log.info(telegram
      ? 'alert channel: telegram'
      : 'alert channel OFF — alerts go to the log and /queues only (set TELEGRAM_ALERT_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID)')
    // ⚠ И то же самое — НА ЭКРАН (#466 §3). Строка в логе видна тому, кто уже смотрит в лог; а
    // выключенная сигнализация молчит ровно так же, как исправная и спокойная.
    recordAlertChannelConfigured(!!telegram)

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
                // Исход КАЖДОЙ попытки — на экран: отозванный бот и неверный chat_id иначе видны
                // только в логе, то есть тому, кто и так уже что-то заподозрил.
                recordAlertDelivery(r.ok, Date.now())
                // Status only — the URL carries the bot token, so nothing else is loggable.
                if (!r.ok) alert.error(`telegram send failed: status=${r.status}`)
                return r.ok
              } catch {
                return false // alerting must never take the cron instance down
              }
            },
            record: recordQueueHealth,
            // ⚠ Порты разведены по РАЗНЫМ каналам осознанно: `warn` несёт сами ТРЕВОГИ (их
            // адресат — оператор, канал `queue-alert`), а `error` — отказы ЧТЕНИЯ состояния,
            // то есть обычную поломку конвейера (канал `queue`, как у соседних строк того же
            // смысла). Свести их в один канал значило бы либо утопить тревоги в потоке ошибок,
            // либо назвать тревогой неудачу запроса к Redis (найдено ревью #529).
            warn: (m: string) => alert.warning(m),
            error: (m: string) => log.error(m),
            queuesUrl,
            // Умирающие банковские подключения — в тот же канал (#497 §3). Карточку на `/queues`
            // надо ОТКРЫТЬ, а refresh Альфы умирает под утро (#488), когда на экран никто не
            // смотрит: пул-дашборд закрыть критерий «МЫ видим его проблемы» не может.
            bankRows: () => listAllBankAccountInfo(dbQuery),
            // Пульс продления (#504). Каденция берётся ТА ЖЕ, что у самого таймера, — иначе
            // оператор, разредивший продление через env, получал бы ложную тревогу на каждом тике.
            keepAlive: () => ({ pulse: keepAlivePulse(), intervalMs: bankKeepAliveMs, startedAtMs: keepAliveStartedAt() }),
            // Живы ли воркеры (#466 §1).
            //
            // ⚠ `queuesEnabled: true` — КОНСТАНТА, а не `queueEnabled()`: плагин выходит выше, если
            // Redis не настроен, поэтому сюда исполнение без него не доходит вовсе. Тернарник тут
            // читался бы как «а вдруг выключены», описывая недостижимую ветку; ревью справедливо
            // назвало её мёртвой. Само правило проверку `queuesEnabled` сохраняет — оно чистое и
            // зовётся не только отсюда.
            //
            // ⚠ `startedAtMs` обязателен: без него холодный старт (`docker compose up` — `backend`
            // поднимается первым, первый тик идёт немедленно) шлёт «нет воркеров», пока `worker`
            // ещё грузится, и так на КАЖДОМ выкате. Соседний `keepAlive` принимает то же и по той
            // же причине.
            workers: async () => ({
              live: await countLiveWorkers(),
              queuesEnabled: true,
              startedAtMs: processStartedAt
            })
          }))
        delivery = result.state
      } catch (err) {
        // runQueueHealthTick swallows its own failures; only a bug in the bindings reaches here.
        log.error(`health check failed: ${(err as Error)?.message}`)
      } finally {
        healthRunning = false
      }
    }
    healthTimer = setInterval(() => void runHealthCheck(), QUEUE_HEALTH_INTERVAL_MS)
    void runHealthCheck()
    log.info(`health check scheduled (every ${QUEUE_HEALTH_INTERVAL_MS / 60_000} min, #426)`)
  } else {
    log.info('cron + event worker disabled (QUEUE_CRON=0) — they run on the primary instance')
  }

  // Failure/error visibility (#78): without a `failed`/`error` listener an exhausted job failure or a
  // worker-level (Redis) error is silent unless the OTel collector runs (default off). Wire greppable,
  // PII-safe log lines onto EVERY started worker (throughput + event + deletion + feedback + trigger).
  const obsDeps = { error: (m: string) => log.error(m), warn: (m: string) => log.warning(m) }
  for (const w of workers) attachWorkerObservability(w, obsDeps)

  nitroApp.hooks.hook('close', async () => {
    if (timer) clearInterval(timer)
    if (pollTimer) clearInterval(pollTimer)
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    if (bankKeepAliveTimer) clearInterval(bankKeepAliveTimer)
    if (sweepTimer) clearInterval(sweepTimer)
    if (batchSweepTimer) clearInterval(batchSweepTimer)
    if (healthTimer) clearInterval(healthTimer)
    if (beatTimer) clearInterval(beatTimer)
    await Promise.all(workers.map(w => w.close()))
    await closeQueues()
  })
})
