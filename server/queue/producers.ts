// Producers — enqueue jobs onto the pipeline. Each is a thin wrapper over
// getQueue(...).add(...) with the deterministic jobId (so retries dedupe). All
// no-op when Redis is not configured (queueEnabled() === false), so callers
// (event webhook, cron, upload handler) stay safe on a backend without Redis.

import { getQueue, queueEnabled } from './connection'
import {
  Q_CRM, Q_DELETIONS, Q_EVENTS, Q_FEEDBACK, Q_FETCH, Q_PARSE,
  crmSyncJobId, deletionJobId, eventJobId, feedbackPostJobId, fetchJobId, parseJobId,
  type CrmSyncJob, type DeletionJob, type EventJob, type FeedbackPostJob, type FetchJob, type ParseJob
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

export async function enqueueFetch(job: FetchJob): Promise<boolean> {
  if (!queueEnabled()) return false
  await getQueue(Q_FETCH).add(Q_FETCH, job, { jobId: fetchJobId(job) })
  return true
}

export async function enqueueParse(job: ParseJob): Promise<boolean> {
  if (!queueEnabled()) return false
  // The parse payload carries the whole file (base64, up to ~2.7 МБ) — statement content (PII).
  // Bounded age-based retention (STATEMENT_JOB_RETENTION, #245) so it doesn't bloat Redis AND a
  // FAILED file ages out quickly — otherwise the content-only jobId would make a re-upload of a
  // previously-failed file a silent no-op (dedup against the retained failed job) instead of re-running.
  await getQueue(Q_PARSE).add(Q_PARSE, job, { jobId: parseJobId(job), ...STATEMENT_JOB_RETENTION })
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
 * backoff (30s, 60s, 120s, …) over `attempts` tries spans a multi-hour GitHub outage. On permanent
 * exhaustion the failed job is kept (age-bound below) for debugging. PII-bearing payload (may embed a
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

export async function enqueueCrmSync(job: CrmSyncJob): Promise<boolean> {
  if (!queueEnabled()) return false
  // The crm-sync payload carries the normalized StatementItem[] (counterparty/account/amount/
  // purpose) — financial PII. Age-bound its retention (#245) instead of the count-based default,
  // so completed batches of statement data age out of Redis promptly. Dedup is the B24 marker,
  // not a retained job, so a re-run is safe.
  await getQueue(Q_CRM).add(Q_CRM, job, { jobId: crmSyncJobId(job), ...STATEMENT_JOB_RETENTION })
  return true
}
