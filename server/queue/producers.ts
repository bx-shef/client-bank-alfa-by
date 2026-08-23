// Producers — enqueue jobs onto the pipeline. Each is a thin wrapper over
// getQueue(...).add(...) with the deterministic jobId (so retries dedupe). All
// no-op when Redis is not configured (queueEnabled() === false), so callers
// (event webhook, cron, upload handler) stay safe on a backend without Redis.

import { getQueue, queueEnabled } from './connection'
import {
  Q_BINDINGS, Q_CRM, Q_DELETIONS, Q_EVENTS, Q_FEEDBACK, fetchQueueFor, Q_PARSE, Q_REGISTRY, Q_TRIGGER,
  activityBindJobId, crmSyncJobId, deletionJobId, eventJobId, feedbackPostJobId, fetchJobId, parseJobId,
  registryWriteJobId, triggerFireJobId,
  type ActivityBindJob, type CrmSyncJob, type DeletionJob, type EventJob, type FeedbackPostJob,
  type FetchJob, type ParseJob, type RegistryWriteJob, type TriggerFireJob
} from './topology'

/**
 * Retention for jobs whose payload carries STATEMENT CONTENT (financial PII, #245): the parsed
 * file (base64, `file-parse`) or the normalized `StatementItem[]` (counterparty / account / amount /
 * purpose, `crm-sync`). Bounded by AGE so this financial data ages OUT of Redis promptly instead of
 * lingering under the count-based default (`DEFAULT_JOB_OPTIONS` keeps up to 1000 completed / 5000
 * failed job payloads). Failed kept longer (a day) for debugging but still bounded. `count` is a
 * secondary cap (Redis size) — whichever limit hits first evicts.
 *
 * Safe for dedup: `crm-sync` idempotency is the B24 activity marker (not a retained job), and a
 * re-enqueued batch simply re-runs (the marker skips already-written ops). `file-parse`'s
 * content-hash jobId means an aged-out FAILED file re-runs on re-upload rather than dedup-vanishing.
 */
export const STATEMENT_JOB_RETENTION = {
  removeOnComplete: { age: 3600, count: 50 },
  removeOnFail: { age: 86400, count: 200 }
} as const

/**
 * Retention for `b24-events` — its ONAPPINSTALL payload carries the portal's OAuth **access token
 * in clear** (+ an encrypted refresh blob). Once the consumer has applied the event (persisted the
 * token), the credential-bearing payload has no reason to linger in Redis history, so remove the
 * COMPLETED job immediately; keep FAILED bounded (a day / 200) so an install/uninstall failure is
 * still debuggable. Idempotency is the DB write + tombstone (#77), not a retained job — safe to drop.
 */
export const CREDENTIAL_JOB_RETENTION = {
  removeOnComplete: true,
  removeOnFail: { age: 86400, count: 200 }
} as const

/** True if the job was enqueued; false if the queue is disabled (no Redis). */
export async function enqueueEvent(job: EventJob): Promise<boolean> {
  if (!queueEnabled()) return false
  // Drop the credential-bearing completed payload promptly (CREDENTIAL_JOB_RETENTION, #245).
  await getQueue(Q_EVENTS).add(Q_EVENTS, job, { jobId: eventJobId(job), ...CREDENTIAL_JOB_RETENTION })
  return true
}

/**
 * Retention for `bank-fetch` — and the load-bearing half of the poller's BACKPRESSURE at
 * marketplace scale (tens of thousands of connected accounts).
 *
 * The cron enqueues one job per connected account per tick, but the fleet can only drain at the
 * bank's rate cap (Alfa: 100 req/min for ALL portals — it is per OAuth client, not per account).
 * A full sweep of N accounts therefore takes `N / rate` minutes, which is far longer than the tick
 * interval. With a per-tick-unique jobId that arithmetic is fatal: every tick adds another N jobs
 * while only `rate × interval` drain, so the queue grows without bound until Redis dies.
 *
 * The fix is a STABLE jobId (the cron omits `epoch`) plus this retention:
 *  - while a job for (portal, account, window) is waiting/active, re-adding the same id is a silent
 *    no-op → a tick can never pile a second copy on an account that is still pending;
 *  - `removeOnComplete: true` frees the id the moment it finishes → the NEXT tick re-polls it.
 * The queue therefore self-limits to at most one job per connected account, and the effective poll
 * cadence degrades gracefully to the drain rate instead of exploding.
 * (Removing the completed payload promptly also keeps account numbers out of Redis history, the
 * same privacy posture as STATEMENT_JOB_RETENTION, #245.)
 *
 * `removeOnFail` is bounded by AGE for the same reason: a failed job keeps its id, so a permanently
 * failing account would otherwise be dedup-blocked from ever being polled again.
 *
 * ⚠ That age alone is NOT enough, because BullMQ's age eviction is LAZY — it runs only from inside
 * another job's `moveToFinished` on the SAME set, and a COMPLETING fetch (removeOnComplete: true)
 * trims nothing at all. So on a queue where fetches mostly succeed, one failed job could sit on its
 * id until another fetch happened to fail an hour later, silently dropping that account from the
 * rotation. The wall-clock guarantee comes from the periodic sweep (`statementSweep.ts`, which
 * includes the fetch queues for exactly this reason); this age is the cutoff that sweep applies.
 */
export const FETCH_JOB_RETENTION = {
  removeOnComplete: true,
  removeOnFail: { age: 3600, count: 500 }
} as const

export async function enqueueFetch(job: FetchJob): Promise<boolean> {
  if (!queueEnabled()) return false
  // Route by provider: Prior's multi-request create+poll has its own queue (own limiter + slots)
  // so it can neither starve Alfa nor under-report its ~10× request cost (see Q_FETCH_PRIOR).
  const queue = fetchQueueFor(job.providerId)
  // Deliberately silent on a duplicate id — that IS the backpressure (see FETCH_JOB_RETENTION).
  await getQueue(queue).add(queue, job, { jobId: fetchJobId(job), ...FETCH_JOB_RETENTION })
  return true
}

/**
 * Free a deterministic jobId from a FINISHED job — completed OR failed (#498).
 *
 * BullMQ dedups `add` against ANY retained job with the same id, and both retention buckets are
 * long enough to matter: a failed job holds its id for a day, a completed one for an hour.
 *
 * ⚠ THAT DEDUP IS RIGHT FOR MACHINES AND WRONG FOR PEOPLE, which is the whole bug. Re-uploading the
 * same file is not a duplicate submission — it is the REPAIR action. The operator watches a run
 * report «117 обработано, 0 создано», fixes the portal (marks the company as «моя», adds the
 * requisite, corrects the account number) and uploads the same file again to make the payments
 * land. Treating that as a duplicate made the second upload a silent no-op AND left the previous
 * «всё разобрано» on screen — the app confirming success for work it had just refused to do.
 *
 * Re-running is safe and cheap by design: the authority on «already written» is the activity MARKER
 * IN BITRIX24 (#259), not a retained Redis job. A re-run re-reads the marker, skips what exists
 * (counted as `skipped`) and writes only what is genuinely missing. Storing that decision on our
 * side was the mistake — see docs/PROCESSING.md.
 *
 * WAITING / ACTIVE / DELAYED jobs keep their dedup: an in-flight job is the one case where a second
 * copy really is a duplicate (double click, redelivery), and that dedup is also the poller's
 * backpressure. Best-effort — `remove()` can race the sweep; «job not found» just means the id is
 * already free.
 */
async function unstickFinished(queue: ReturnType<typeof getQueue>, jobId: string): Promise<void> {
  await unstick(queue, jobId, state => state === 'failed' || state === 'completed')
}

/** Free the id of a FAILED job only (C3, the 24h deadlock): attempts exhausted on a broken token
 *  would otherwise block that id for a day. Used on the machine-driven path, where a COMPLETED job
 *  keeps its dedup on purpose — see `enqueueCrmSync`. */
async function unstickFailedOnly(queue: ReturnType<typeof getQueue>, jobId: string): Promise<void> {
  await unstick(queue, jobId, state => state === 'failed')
}

/**
 * ⚠ THE READ AND THE REMOVE ARE NOT ATOMIC, and both BullMQ calls address the job by ID rather than
 * by the snapshot we read. Two producers racing on the same id can therefore interleave so that the
 * second one removes the job the first one just added, and the first `enqueue*` returns `true` for
 * work that no longer exists.
 *
 * That is harmless HERE and only here, because every id that can collide is derived from content
 * (file hash / batch hash): whichever job survives carries an equivalent payload, so the work still
 * happens and the loser cost nothing but Redis churn. ⚠ Reusing this helper on a queue whose ids
 * are NOT content-derived would turn the same race into silently dropped work — check that first.
 *
 * An ACTIVE job is safe regardless: BullMQ refuses to remove a job locked by a worker, the throw
 * lands in the catch, and the trailing `add` dedups against it as usual.
 */
async function unstick(
  queue: ReturnType<typeof getQueue>,
  jobId: string,
  shouldRemove: (state: string) => boolean
): Promise<void> {
  try {
    const existing = await queue.getJob(jobId)
    if (!existing) return
    if (shouldRemove(await existing.getState())) await existing.remove()
  } catch {
    // Lost a race with eviction/sweep — the id is free (or will dedup); either way `add` proceeds.
  }
}

export async function enqueueParse(job: ParseJob): Promise<boolean> {
  if (!queueEnabled()) return false
  // The parse payload carries the whole file (base64, up to ~2.7 МБ) — statement content (PII).
  // Bounded age-based retention (STATEMENT_JOB_RETENTION, #245) so it doesn't bloat Redis AND a
  // FAILED file ages out quickly. Age alone is not enough: eviction is lazy, and a finished job of
  // either kind would dedup-block a re-upload — the one action an operator has (#498).
  //
  // This producer has exactly ONE caller: POST /api/import, i.e. a human pressing «Записать в CRM».
  // That is why freeing a finished id here is safe in a way it would not be on a machine-driven
  // queue: nothing else can call it in a loop.
  const queue = getQueue(Q_PARSE)
  await unstickFinished(queue, parseJobId(job))
  await queue.add(Q_PARSE, job, { jobId: parseJobId(job), ...STATEMENT_JOB_RETENTION })
  return true
}

export async function enqueueDeletion(job: DeletionJob): Promise<boolean> {
  if (!queueEnabled()) return false
  // The deletion payload carries only an id + entityTypeId (no financial PII, §9.2), so the default
  // retention is fine. `deletionJobId` (member|event|id|ts) dedups redelivery of the same deletion.
  await getQueue(Q_DELETIONS).add(Q_DELETIONS, job, { jobId: deletionJobId(job) })
  return true
}

/**
 * Durable-retry options for the feedback outbox (#61). The route already attempted the GitHub POST
 * ONCE synchronously and got a transient failure, so these attempts are the RETRIES: exponential
 * backoff (30s, 60s, 120s, …, up to ~32 min) over 8 tries spans ~1 hour of GitHub flakiness. On
 * permanent exhaustion the failed job is kept (age-bound below) for debugging. PII-bearing payload (may embed a
 * statement excerpt) → age-bound retention like statement jobs.
 */
export const FEEDBACK_RETRY_OPTS = {
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  ...STATEMENT_JOB_RETENTION
} as const

/** Enqueue a feedback issue for durable retry after a TRANSIENT GitHub failure (#61). No-op (false)
 *  without Redis — the caller then surfaces the original transient error to the client instead. */
export async function enqueueFeedbackPost(job: FeedbackPostJob): Promise<boolean> {
  if (!queueEnabled()) return false
  await getQueue(Q_FEEDBACK).add(Q_FEEDBACK, job, { jobId: feedbackPostJobId(job), ...FEEDBACK_RETRY_OPTS })
  return true
}

/**
/**
 * Retention for repair jobs whose payload carries NO statement (`trigger-fire`, `activity-bind`).
 *
 * ⚠ A named constant because this literal already appeared in the file twice, character for
 * character. A future retention change (say, a shorter `removeOnFail` after a privacy review) gets
 * applied to the named constants, and the third inline copy would silently keep the old policy with
 * no test to notice.
 */
export const CRM_RETRY_RETENTION = {
  removeOnComplete: { age: 3600, count: 100 },
  removeOnFail: { age: 86_400, count: 200 }
} as const

/**
 * Durable-retry options for the payment-trigger self-heal (#79). crm-sync already fired ONCE, so these
 * are the retries: exponential backoff `60s·2^(n-1)` over 12 attempts (11 retries) — cumulative span
 * ~34h (top interval ~17h). A long window because the common miss is a `triggerCode`
 * set-but-not-yet-registered, so the retries should outlast the admin registering it. The payload holds
 * no amount/counterparty/purpose — only target ids, the app CODE, and `opKey` (`account|docId`, an
 * account number, same as `fetchJobId`) — and is age-bound below, so it doesn't linger.
 */
export const TRIGGER_RETRY_OPTS = {
  attempts: 12,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  ...CRM_RETRY_RETENTION
} as const

/**
 * Durable retry for the payment-registry write (#578) and the activity bindings (#585).
 *
 * ⚠ The window is SHORTER than the trigger's (~34 h there), and that is not carelessness. The
 * trigger waits for an ADMIN ACTION — registering the CODE — so its retries must outlive a working
 * day. Here what is being healed is a portal/network failure: it either clears within tens of
 * minutes or not at all, and a day of fruitless attempts only burns the client's request budget.
 *
 * ⚠ The ladder: 8 attempts = 7 retries at `30s·2^(n-1)`, i.e. 30+60+120+240+480+960+1920 s =
 * **3810 s ≈ 1 hour** (top interval ~32 min) — the very same ladder as `FEEDBACK_RETRY_OPTS` above. The
 * number is spelled out because the first draft wrote «~2 hours», and that figure was already
 * cited by the queue's stall budget AND by `PRIVACY.md` (how long statement PII sits in Redis). A
 * number derived wrong once spreads through documents silently.
 *
 * ⚠ Retention for jobs carrying a STATEMENT is age-bound (`STATEMENT_JOB_RETENTION`, #245) — the
 * registry payload is financial PII. The bindings payload is CRM ids, so it takes the ordinary one.
 */
export const DEFERRED_WRITE_RETRY = {
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 30_000 }
} as const

/** Queue a deferred registry-element write (#578). No-op (false) without Redis — behaviour then
 *  degrades to the previous one: the failure is counted and lost. */
export async function enqueueRegistryWrite(job: RegistryWriteJob): Promise<boolean> {
  if (!queueEnabled()) return false
  await getQueue(Q_REGISTRY).add(Q_REGISTRY, job, {
    jobId: registryWriteJobId(job), ...DEFERRED_WRITE_RETRY, ...STATEMENT_JOB_RETENTION
  })
  return true
}

/** Поставить дозапись привязок дела (#585). No-op (false) без Redis. */
export async function enqueueActivityBind(job: ActivityBindJob): Promise<boolean> {
  if (!queueEnabled()) return false
  await getQueue(Q_BINDINGS).add(Q_BINDINGS, job, {
    jobId: activityBindJobId(job), ...DEFERRED_WRITE_RETRY, ...CRM_RETRY_RETENTION
  })
  return true
}

/** Enqueue a payment trigger for durable retry after a missed synchronous fire (#79). No-op (false)
 *  without Redis — the trigger then degrades to the prior single-shot behavior. */
export async function enqueueTriggerFire(job: TriggerFireJob): Promise<boolean> {
  if (!queueEnabled()) return false
  await getQueue(Q_TRIGGER).add(Q_TRIGGER, job, { jobId: triggerFireJobId(job), ...TRIGGER_RETRY_OPTS })
  return true
}

export async function enqueueCrmSync(job: CrmSyncJob): Promise<boolean> {
  if (!queueEnabled()) return false
  // The crm-sync payload carries the normalized StatementItem[] (counterparty/account/amount/
  // purpose) — financial PII. Age-bound its retention (#245) instead of the count-based default,
  // so completed batches of statement data age out of Redis promptly. Dedup is the B24 marker,
  // not a retained job, so a re-run is safe.
  //
  // ⚠ WHICH FINISHED JOBS WE FREE DEPENDS ON WHO ASKED, and the two sources are genuinely
  // different (#498):
  //
  //  - `parse` — a person re-uploaded the file. Freeing a COMPLETED id is the point: unsticking
  //    only the parse queue would move the deadlock one step down the pipeline, because the fresh
  //    parse chains into a crm-sync whose id is the same file hash. The operator would watch the
  //    file parse again and still see nothing appear in CRM.
  //  - `fetch` — the cron re-polled. Its batchId is a CONTENT hash, so an identical id means
  //    genuinely identical operations, and re-running would re-read B24 markers for every one of
  //    them at fleet scale to conclude «already written». That dedup is load-bearing; keep it, and
  //    free only a FAILED corpse (attempts exhausted, e.g. a broken token) so a fixed account is
  //    not blocked out of the rotation for a day.
  const queue = getQueue(Q_CRM)
  if (job.source === 'parse') await unstickFinished(queue, crmSyncJobId(job))
  else await unstickFailedOnly(queue, crmSyncJobId(job))
  await queue.add(Q_CRM, job, { jobId: crmSyncJobId(job), ...STATEMENT_JOB_RETENTION })
  return true
}
