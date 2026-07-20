import type { FeedbackConfig } from './feedbackConfig'
import type { IssuePayload } from '../../app/utils/feedback'

// Transport: POST the built issue to the GitHub REST API. DI over a minimal fetch fn (tested with a
// fake). SECURITY: never log the token, the request URL or the response body. Only the numeric
// status is surfaced. Retryable on transient transport (5xx / 429); auth/validation
// (401/403/404/422) are not.

/** The subset of the fetch API this transport uses (DI seam for tests). */
export type FeedbackFetchFn = (
  url: string,
  init: { method: string, headers: Record<string, string>, body: string }
) => Promise<{ status: number, json: () => Promise<unknown> }>

export interface PostIssueResult {
  ok: boolean
  status: number
  /** Issue number on success. */
  number?: number
  /** Could a later retry plausibly succeed (drives a future durable outbox)? */
  retryable: boolean
}

export async function postFeedbackIssue(config: FeedbackConfig, payload: IssuePayload, fetchFn: FeedbackFetchFn): Promise<PostIssueResult> {
  let res: Awaited<ReturnType<FeedbackFetchFn>>
  try {
    res = await fetchFn(`https://api.github.com/repos/${config.repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'client-bank-alfa-feedback',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify(payload)
    })
  } catch {
    // Network error — transient, retryable. Do not include the error (may echo the URL/token).
    return { ok: false, status: 0, retryable: true }
  }
  const status = res.status
  if (status === 201) {
    const num = await res.json().then((j: unknown) => Number((j as { number?: unknown })?.number)).catch(() => Number.NaN)
    return { ok: true, status, retryable: false, ...(Number.isInteger(num) && num > 0 ? { number: num } : {}) }
  }
  return { ok: false, status, retryable: status >= 500 || status === 429 }
}
