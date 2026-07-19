// Pure request logic for POST /api/distribution/provision (#109, §9.1 live-обвязка). Gates the
// provisioning-execution behind: a feature flag (default OFF), the caller's B24 FRAME token
// (proves portal membership + carries the ADMIN flag), and portal-installed check. The compound
// provisioning itself is `handleProvisionDistribution` (single-flight + persist), injected as
// `provision`. Thin over DI — unit-testable without pg / network / the SDK.
//
// Auth model mirrors /api/poll-now: the frame access token is itself the CSRF defense (only the
// in-portal iframe holds it); `member_id` is resolved server-side from the domain (never trusted
// from the client), and `validateFrame` re-checks the token against B24 to block a spoofed domain.

import type { ProvisionDistributionOutcome } from './distributionProvisionHandler'

/** Injected side effects + config for {@link handleProvisionRequest}. */
export interface ProvisionRequestDeps {
  /** Feature gate: provisioning is OFF unless the owner opts in (default false, fail-closed). */
  enabled: boolean
  /** Resolve the caller's portal member id from its domain (proves the app is installed). */
  memberIdByDomain: (domain: string) => Promise<string>
  /** Re-check the frame token against B24: returns the user id (membership proof) + admin flag. */
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** Run the single-flight provisioning + persist for this portal. Runs on the portal's STORED
   *  OAuth token (proven app-context for `crm.type.add`/`userfieldconfig.add`), not the frame
   *  token — the frame token above serves only as the membership + admin gate. */
  provision: (memberId: string) => Promise<ProvisionDistributionOutcome>
}

export interface ProvisionRequestResult {
  status: number
  body: Record<string, unknown>
}

/**
 * Handle one provision request: gate → auth → provision. Order matters — the feature gate is
 * checked first (a disabled feature reveals nothing), then frame auth (400 no creds → 409 not
 * installed → 401 bad token → 403 not admin), then the provisioning. A downstream error maps to
 * 502 (the outcome body is only returned on success). Never throws.
 */
export async function handleProvisionRequest(
  deps: ProvisionRequestDeps,
  input: { accessToken: string, domain: string }
): Promise<ProvisionRequestResult> {
  if (!deps.enabled) return { status: 404, body: { error: 'provisioning disabled' } }

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
    // The token didn't validate against B24 (expired / wrong domain / spoof) → unauthorized.
    return { status: 401, body: { error: 'invalid frame token' } }
  }
  if (!frame.userId) return { status: 401, body: { error: 'invalid frame token' } }
  if (!frame.isAdmin) return { status: 403, body: { error: 'admin required' } }

  try {
    const outcome = await deps.provision(memberId)
    return {
      status: 200,
      body: {
        ok: true,
        paymentSpEtid: outcome.paymentSpEtid,
        distributionSpEtid: outcome.distributionSpEtid,
        created: outcome.createdPaymentSp || outcome.createdDistributionSp,
        addedFields: outcome.addedFields,
        storedChanged: outcome.storedChanged
      }
    }
  } catch {
    return { status: 502, body: { error: 'provisioning failed' } }
  }
}
