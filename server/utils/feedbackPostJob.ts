import type { FeedbackPostJob } from '../queue/topology'
import type { PostIssueResult } from './feedbackGithub'
import type { IssuePayload } from '../../app/utils/feedback'

// Pure worker for the feedback durable outbox (#61). The payload is the ALREADY-BUILT, sanitized
// GitHub issue (the route did auth + Trojan-Source strip + HTML-escape before enqueueing), so no raw
// untrusted input is handled here — this only re-attempts the transport. DI over the side effects
// (POST + metric) → unit-testable without Redis / network.

export interface FeedbackPostJobDeps {
  /** POST the built issue. Mirrors the route's transport (postFeedbackIssue bound to config+fetch). */
  postIssue: (payload: IssuePayload) => Promise<PostIssueResult>
  /** Best-effort telemetry (#195) on EVENTUAL success — mirrors the synchronous path. Optional. */
  recordMetric?: (memberId: string, kind: 'up' | 'down') => Promise<void>
}

/**
 * Re-post a transiently-failed feedback issue.
 * - success → best-effort metric, then ack (return).
 * - transient failure (5xx / 429 / network) → THROW so BullMQ retries with backoff (attempts capped
 *   in FEEDBACK_RETRY_OPTS).
 * - permanent failure (4xx auth/validation) → log + ack (a retry can't succeed; drop from the outbox).
 */
export async function handleFeedbackPostJob(job: FeedbackPostJob, deps: FeedbackPostJobDeps): Promise<void> {
  const result = await deps.postIssue(job.payload)
  if (result.ok) {
    if (deps.recordMetric) {
      try {
        await deps.recordMetric(job.memberId, job.kind)
      } catch { /* best-effort — a metric write must never fail an already-created issue */ }
    }
    return
  }
  if (result.retryable) {
    // Numeric class only — never the GitHub body/URL/token (feedbackGithub keeps those out too).
    throw new Error(`feedback issue post failed (status ${result.status}) — retry`)
  }
  console.warn('[feedback] permanent post failure status=%d — dropped from outbox', result.status)
}
