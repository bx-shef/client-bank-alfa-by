// Pure handler for POST /api/feedback — the «сотрудник» channel (docs/FEEDBACK.md). Frame-token
// auth model mirrors /api/app-rating and /api/import/status: resolve the portal by domain, validate
// the token via `profile` (blocks X-B24-Domain spoofing), then file the GitHub issue. DI over the
// side effects (config gate, member resolution, issue POST) → unit-testable without a DB / network.

import { normalizeKind, type FeedbackContext } from '../../app/utils/feedback'
import type { FeedbackConfig } from './feedbackConfig'
import type { PostIssueResult } from './feedbackGithub'

export interface FeedbackSubmitDeps {
  /** The resolved channel config, or null when the channel is disabled (→ 503). */
  config: FeedbackConfig | null
  memberIdByDomain: (domain: string) => Promise<string | null>
  validateFrame: (domain: string, accessToken: string) => Promise<string>
  /** File the issue in the receiving repo. Only called when `config` is non-null. */
  postIssue: (kind: 'up' | 'down', comment: unknown, context: FeedbackContext) => Promise<PostIssueResult>
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
 * - GitHub transport failed → 502 (retryable) / 500
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
  // receiving repo is private so client data is permitted (see feedback.ts module header).
  const result = await deps.postIssue(kind, input.comment, input.context ?? {})
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
  return { status: result.retryable ? 502 : 500, body: { error: 'не удалось отправить отзыв' } }
}
