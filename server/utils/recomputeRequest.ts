// Pure request logic for POST /api/distribution/recompute (#109, §3/§9.2 «пересчитать»). Same gate
// model as /api/distribution/ledger (feature flag + frame admin + installed). Recomputes «осталось»
// for every payment carrier — the manual recovery backstop (deletion crash-window / drift). Thin over
// DI — unit-testable without pg / network / the SDK.

/** Injected side effects + config for {@link handleRecomputeRequest}. */
export interface RecomputeRequestDeps {
  /** Feature gate: OFF unless the owner opts in (default false, fail-closed). */
  enabled: boolean
  memberIdByDomain: (domain: string) => Promise<string>
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** Recompute every payment carrier for the portal (single-flight). Returns the count, or `null`
   *  when the distribution SPs aren't provisioned. */
  recompute: (memberId: string) => Promise<number | null>
}

export interface RecomputeRequestResult {
  status: number
  body: Record<string, unknown>
}

/**
 * Handle one recompute request: gate → auth → recompute. Order: feature gate (404) → frame auth
 * (400 no creds → 409 not installed → 401 bad token → 403 not admin) → recompute. Not provisioned ⇒
 * `200 {provisioned:false, recomputed:0}`. A downstream error maps to 502. Never throws.
 */
export async function handleRecomputeRequest(
  deps: RecomputeRequestDeps,
  input: { accessToken: string, domain: string }
): Promise<RecomputeRequestResult> {
  if (!deps.enabled) return { status: 404, body: { error: 'distribution disabled' } }

  const accessToken = (input.accessToken || '').trim()
  const domain = (input.domain || '').trim()
  if (!accessToken || !domain) return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }

  let memberId: string
  try {
    memberId = await deps.memberIdByDomain(domain)
  } catch {
    return { status: 502, body: { error: 'upstream error' } }
  }
  if (!memberId) return { status: 409, body: { error: 'portal not installed' } }

  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 401, body: { error: 'invalid frame token' } }
  }
  if (!frame.userId) return { status: 401, body: { error: 'invalid frame token' } }
  if (!frame.isAdmin) return { status: 403, body: { error: 'admin required' } }

  try {
    const recomputed = await deps.recompute(memberId)
    if (recomputed === null) return { status: 200, body: { provisioned: false, recomputed: 0 } }
    return { status: 200, body: { ok: true, recomputed } }
  } catch {
    return { status: 502, body: { error: 'recompute failed' } }
  }
}
