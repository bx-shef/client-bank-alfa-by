// Pure handler for GET /api/import/status (#5) — returns the portal's last import run
// (ImportRunSummary) for the in-portal UI. Auth = the B24 frame token (same model as
// /api/import, /api/chat-settings): resolve the portal by domain, validate the token
// via `profile` (blocks X-B24-Domain spoofing — a token minted for another portal
// fails), then read the stored result. DI over the side-effects → unit-testable.

import type { ImportRunSummary } from '../../app/types/importStatus'
import { emptyImportSummary } from '../../app/utils/importStatus'

export interface ImportStatusDeps {
  /** Resolve the portal member_id by its domain (null ⇒ app not installed). */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Validate the frame access token for `domain` (returns the user id, or throws /
   *  returns '' on a bad/foreign token). Proves the caller belongs to THIS portal. */
  validateFrame: (domain: string, accessToken: string) => Promise<string>
  /** Read the stored last-run summary for the portal (null ⇒ never run yet). */
  getResult: (memberId: string) => Promise<ImportRunSummary | null>
}

/**
 * Resolve the import status for a frame-authenticated request.
 * - missing token/domain → 401
 * - portal not installed (no token for the domain) → 409 (same as /api/import)
 * - frame token invalid / belongs to another portal → 403
 * - else 200 with the stored summary (or `neverSummary()` if none)
 */
export async function handleImportStatus(
  deps: ImportStatusDeps,
  input: { accessToken: string, domain: string }
): Promise<{ status: number, body: ImportRunSummary | { error: string } }> {
  const accessToken = input.accessToken.trim()
  const domain = input.domain.trim()
  if (!accessToken || !domain) return { status: 401, body: { error: 'frame token + domain required' } }

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed' } }

  // The token must be valid FOR THIS portal — a token from another portal fails against
  // the spoofed X-B24-Domain (B24 scopes the token), so cross-portal read is blocked.
  let userId: string
  try {
    userId = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token' } }
  }
  if (!userId) return { status: 403, body: { error: 'invalid frame token' } }

  const result = await deps.getResult(memberId)
  return { status: 200, body: result ?? emptyImportSummary() }
}
