// Pure handler for POST /api/feedback — the «сотрудник» channel (docs/FEEDBACK.md). Frame-token
// auth model mirrors /api/app-rating and /api/import/status: resolve the portal by domain, validate
// the token via `profile` (blocks X-B24-Domain spoofing), then file the GitHub issue. DI over the
// side effects (config gate, member resolution, issue POST) → unit-testable without a DB / network.

import { normalizeKind, type FeedbackContext, type IssuePayload } from '../../app/utils/feedback'
import type { FeedbackConfig } from './feedbackConfig'
import type { PostIssueResult } from './feedbackGithub'

export interface FeedbackSubmitDeps {
  /** The resolved channel config, or null when the channel is disabled (→ 503). */
  config: FeedbackConfig | null
  memberIdByDomain: (domain: string) => Promise<string | null>
  validateFrame: (domain: string, accessToken: string) => Promise<string>
  /** Build + SANITIZE the issue (Trojan-Source strip / HTML-escape). Called when `config` is non-null;
   *  the returned payload is what we POST and — on a transient failure — what we enqueue. */
  buildIssue: (kind: 'up' | 'down', comment: unknown, context: FeedbackContext) => IssuePayload
  /** File the built issue in the receiving repo. Only called when `config` is non-null. */
  postIssue: (payload: IssuePayload) => Promise<PostIssueResult>
  /** Durable outbox (#61): on a TRANSIENT GitHub failure, hand the built issue to the retry queue.
   *  Returns true if it was enqueued (→ 202). Absent / false (no Redis) ⇒ fall back to the 502. */
  enqueueRetry?: (payload: IssuePayload, memberId: string, kind: 'up' | 'down') => Promise<boolean>
  /** Best-effort telemetry (#195): record that a rating was sent (BOTH 👍 and 👎). Called ONLY on a
   *  successfully-filed issue; a failure here must never fail the already-created issue. Optional. */
  recordMetric?: (memberId: string, kind: 'up' | 'down') => Promise<void>
}

export interface FeedbackSubmitInput {
  accessToken: string
  domain: string
  kind: unknown
  comment: unknown
  context?: FeedbackContext
}

/**
 * Decide the response for a feedback submission.
 * - channel not configured → 503
 * - missing token/domain → 401
 * - unknown kind → 400
 * - portal not installed → 409
 * - frame token invalid / foreign → 403
 * - GitHub permanent failure (4xx) → 500
 * - GitHub transient failure (5xx/429/network) → 202 if handed to the durable outbox (#61), else 502
 * - else 200 { ok, number }
 */
export async function handleFeedbackSubmit(
  deps: FeedbackSubmitDeps,
  input: FeedbackSubmitInput
): Promise<{ status: number, body: Record<string, unknown> }> {
  if (!deps.config) return { status: 503, body: { error: 'канал отзывов не настроен' } }

  const accessToken = input.accessToken.trim()
  const domain = input.domain.trim()
  if (!accessToken || !domain) return { status: 401, body: { error: 'frame token + domain required' } }

  const kind = normalizeKind(input.kind)
  if (!kind) return { status: 400, body: { error: 'неизвестная оценка' } }

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed' } }

  let userId: string
  try {
    userId = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token' } }
  }
  if (!userId) return { status: 403, body: { error: 'invalid frame token' } }

  // Context (fileName/appVersion) is client-supplied and rendered inert by the builder; the
  // receiving repo is private so client data is permitted (see feedback.ts module header). Build +
  // sanitize ONCE, then POST; the same built payload is what we'd enqueue on a transient failure.
  const payload = deps.buildIssue(kind, input.comment, input.context ?? {})
  const result = await deps.postIssue(payload)
  if (result.ok) {
    // Telemetry (#195): count the sent rating (both 👍/👎). Best-effort — a counter write must
    // never fail an already-created issue.
    if (deps.recordMetric) {
      try {
        await deps.recordMetric(memberId, kind)
      } catch { /* best-effort */ }
    }
    return { status: 200, body: { ok: true, ...(result.number ? { number: result.number } : {}) } }
  }
  // Permanent (4xx auth/validation) — a retry can't help. Surface 500, don't queue.
  if (!result.retryable) return { status: 500, body: { error: 'не удалось отправить отзыв' } }
  // Transient (5xx/429/network) — hand the built issue to the durable outbox (#61) so it survives a
  // GitHub blip / the employee closing the tab. Enqueued ⇒ 202 accepted; no queue (no Redis) ⇒ 502.
  if (deps.enqueueRetry) {
    try {
      if (await deps.enqueueRetry(payload, memberId, kind)) {
        return { status: 202, body: { ok: true, queued: true } }
      }
    } catch { /* enqueue failure → fall through to the transient 502 */ }
  }
  return { status: 502, body: { error: 'не удалось отправить отзыв' } }
}
