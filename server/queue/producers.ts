// Producers — enqueue jobs onto the pipeline. Each is a thin wrapper over
// getQueue(...).add(...) with the deterministic jobId (so retries dedupe). All
// no-op when Redis is not configured (queueEnabled() === false), so callers
// (event webhook, cron, upload handler) stay safe on a backend without Redis.

import { getQueue, queueEnabled } from './connection'
import {
  Q_CRM, Q_EVENTS, Q_FETCH, Q_PARSE,
  crmSyncJobId, eventJobId, fetchJobId, parseJobId,
  type CrmSyncJob, type EventJob, type FetchJob, type ParseJob
} from './topology'

/** True if the job was enqueued; false if the queue is disabled (no Redis). */
export async function enqueueEvent(job: EventJob): Promise<boolean> {
  if (!queueEnabled()) return false
  await getQueue(Q_EVENTS).add(Q_EVENTS, job, { jobId: eventJobId(job) })
  return true
}

export async function enqueueFetch(job: FetchJob): Promise<boolean> {
  if (!queueEnabled()) return false
  await getQueue(Q_FETCH).add(Q_FETCH, job, { jobId: fetchJobId(job) })
  return true
}

export async function enqueueParse(job: ParseJob): Promise<boolean> {
  if (!queueEnabled()) return false
  // The parse payload carries the whole file (base64, up to ~2.7 МБ). Override the
  // count-based default retention with a tight age-based one so retained parse jobs
  // don't bloat Redis, AND so a FAILED file ages out quickly — otherwise the
  // content-only jobId would make a re-upload of a previously-failed file a silent
  // no-op (dedup against the retained failed job) instead of re-running it.
  await getQueue(Q_PARSE).add(Q_PARSE, job, {
    jobId: parseJobId(job),
    removeOnComplete: { age: 3600, count: 50 },
    removeOnFail: { age: 86400, count: 200 }
  })
  return true
}

export async function enqueueCrmSync(job: CrmSyncJob): Promise<boolean> {
  if (!queueEnabled()) return false
  await getQueue(Q_CRM).add(Q_CRM, job, { jobId: crmSyncJobId(job) })
  return true
}
