// Pure handlers for the per-portal metrics dashboard (#78) — GET /api/import/metrics
// and POST /api/import/metrics-reset. Auth = the B24 frame token, same model as
// /api/import/status: resolve the portal by domain, validate the token via `profile`
// (blocks X-B24-Domain spoofing), then read/reset the member-scoped counters. DI over
// side-effects → unit-testable without a server or DB.

export interface MetricsDeps {
  /** Resolve the portal member_id by its domain (null ⇒ app not installed). */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Validate the frame access token for `domain`: returns the caller's user id (empty ⇒ bad/foreign
   *  token) AND whether they're a portal admin (`profile.ADMIN`), or throws. One `profile` call proves
   *  the caller belongs to THIS portal and gates the admin-only reset. */
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** Read all counters for the portal as a plain map. */
  readCounters: (memberId: string) => Promise<Record<string, number>>
  /** Reset (delete) all counters for the portal. */
  resetCounters: (memberId: string) => Promise<void>
}

/** Shared frame-auth prologue: resolve + validate, or an error response. Returns the member_id on
 *  success. Mirrors handleImportStatus's auth ladder (401/409/403). With `requireAdmin`, a validated
 *  but non-admin caller is rejected 403 (the mutating reset is admin-only, #182 parity). */
async function authMember(
  deps: MetricsDeps,
  input: { accessToken: string, domain: string },
  opts: { requireAdmin?: boolean } = {}
): Promise<{ memberId: string } | { status: number, body: { error: string } }> {
  const accessToken = input.accessToken.trim()
  const domain = input.domain.trim()
  if (!accessToken || !domain) return { status: 401, body: { error: 'frame token + domain required' } }

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed' } }

  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token' } }
  }
  if (!frame.userId) return { status: 403, body: { error: 'invalid frame token' } }
  if (opts.requireAdmin && !frame.isAdmin) return { status: 403, body: { error: 'metrics reset requires a portal administrator' } }
  return { memberId }
}

/** GET /api/import/metrics — the portal's lifetime counters (member-scoped). */
export async function handleMetrics(
  deps: MetricsDeps,
  input: { accessToken: string, domain: string }
): Promise<{ status: number, body: { counters: Record<string, number> } | { error: string } }> {
  const auth = await authMember(deps, input)
  if ('status' in auth) return auth
  const counters = await deps.readCounters(auth.memberId)
  return { status: 200, body: { counters } }
}

/** POST /api/import/metrics-reset — clear the portal's counters, return the empty map. */
export async function handleMetricsReset(
  deps: MetricsDeps,
  input: { accessToken: string, domain: string }
): Promise<{ status: number, body: { counters: Record<string, number> } | { error: string } }> {
  const auth = await authMember(deps, input, { requireAdmin: true })
  if ('status' in auth) return auth
  await deps.resetCounters(auth.memberId)
  return { status: 200, body: { counters: {} } }
}
