// Pure {status, body} decision for POST /api/ops/app-rating — the operator's manual review-state
// controls (mirrors the token-refresh ops handler). DI over the store writes so it unit-tests
// without a DB. The route does I/O + operator auth only.

export type AppRatingOpAction = 'reviewed' | 'reset'

export interface AppRatingOpsDeps {
  /** Mark a confirmed review (terminal). */
  markReviewed: (memberId: string) => Promise<void>
  /** Clear opened/prompted so the modal returns (no review appeared). */
  reset: (memberId: string) => Promise<void>
}

/** A B24 member_id is a hex id — validate before it reaches the query. */
function validMemberId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-f0-9]{8,64}$/i.test(v.trim())
}

function validAction(v: unknown): v is AppRatingOpAction {
  return v === 'reviewed' || v === 'reset'
}

/** Decide the response for an operator rating-state change. */
export async function handleAppRatingOp(
  memberId: unknown,
  action: unknown,
  deps: AppRatingOpsDeps
): Promise<{ status: number, body: Record<string, unknown> }> {
  if (!validMemberId(memberId)) return { status: 400, body: { error: 'invalid memberId' } }
  if (!validAction(action)) return { status: 400, body: { error: 'invalid action' } }
  const id = memberId.trim()
  if (action === 'reviewed') await deps.markReviewed(id)
  else await deps.reset(id)
  return { status: 200, body: { ok: true, action } }
}
