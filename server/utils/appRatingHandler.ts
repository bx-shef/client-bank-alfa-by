// Pure handlers for the frame-authenticated «оцените приложение» routes (GET/POST /api/app-rating).
// Auth model mirrors /api/import/status: resolve the portal by domain, then validate the frame
// access token via `profile` (blocks X-B24-Domain spoofing — a token minted for another portal
// fails). DI over the side effects → unit-testable without a DB or a live portal.

import type { AppRatingState } from './appRatingPolicy'
import { shouldPrompt } from './appRatingPolicy'

export interface AppRatingShowDeps {
  /** Resolve the portal member_id by its domain (null ⇒ app not installed). */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Validate the frame access token for `domain` (returns the user id, '' or throws on a bad /
   *  foreign token). Proves the caller belongs to THIS portal. */
  validateFrame: (domain: string, accessToken: string) => Promise<string>
  /** Read the stored rating state for the portal (null ⇒ no row yet). */
  getState: (memberId: string) => Promise<AppRatingState | null>
  /** Injected clock for a deterministic throttle decision. */
  now: () => Date
}

/**
 * GET decision: should the rating modal be shown for this frame request? Side-effect-free.
 * Any auth miss (not framed, app not installed, bad token) resolves to `show:false` — never a nag
 * and never an error, so the in-portal UI degrades silently. Status is always 200.
 */
export async function handleAppRatingShow(
  deps: AppRatingShowDeps,
  input: { accessToken: string, domain: string }
): Promise<{ status: number, body: { show: boolean } }> {
  const accessToken = input.accessToken.trim()
  const domain = input.domain.trim()
  if (!accessToken || !domain) return { status: 200, body: { show: false } }

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 200, body: { show: false } }

  let userId: string
  try {
    userId = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 200, body: { show: false } }
  }
  if (!userId) return { status: 200, body: { show: false } }

  const state = await deps.getState(memberId)
  return { status: 200, body: { show: shouldPrompt(state, deps.now()) } }
}

export type RatingReportAction = 'prompted' | 'opened'

export interface AppRatingReportDeps {
  memberIdByDomain: (domain: string) => Promise<string | null>
  validateFrame: (domain: string, accessToken: string) => Promise<string>
  /** The modal was shown → throttle the next prompt. */
  markPrompted: (memberId: string) => Promise<void>
  /** The user clicked «Оценить» → suppress until manual verification. */
  markOpened: (memberId: string) => Promise<void>
}

/**
 * POST decision: record a rating-prompt lifecycle event ({ action: 'prompted' | 'opened' }).
 * - missing token/domain → 401
 * - unknown action → 400
 * - portal not installed → 409 (same as /api/import)
 * - frame token invalid / foreign → 403
 * - else 200 { ok: true }
 */
export async function handleAppRatingReport(
  deps: AppRatingReportDeps,
  input: { accessToken: string, domain: string, action: unknown }
): Promise<{ status: number, body: Record<string, unknown> }> {
  const accessToken = input.accessToken.trim()
  const domain = input.domain.trim()
  if (!accessToken || !domain) return { status: 401, body: { error: 'frame token + domain required' } }

  const action = input.action
  if (action !== 'prompted' && action !== 'opened') return { status: 400, body: { error: 'unknown action' } }

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed' } }

  let userId: string
  try {
    userId = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token' } }
  }
  if (!userId) return { status: 403, body: { error: 'invalid frame token' } }

  if (action === 'prompted') await deps.markPrompted(memberId)
  else await deps.markOpened(memberId)
  return { status: 200, body: { ok: true } }
}
