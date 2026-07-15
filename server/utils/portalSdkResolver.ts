// Per-portal RestCall resolver on the @bitrix24/b24jssdk transport (#191). The SDK's
// per-instance RestrictionManager (leaky-bucket rate limiter + retry-backoff on
// QUERY_LIMIT_EXCEEDED / 429 / 5xx) IS the rate-limiter — this is why we swap the crm-sync
// transport to it (the neighbouring ai-price-import repo did the same: it abandoned building
// its own limiter and took the SDK's).
//
// DESIGN — a FRESH client per resolution, NOT a process-lifetime cache. A cached B24OAuth
// holds the refresh token in memory; if a peer replica or the keep-alive cron (#175) rotates
// it, the cached client would wedge on `invalid_grant` forever. Building fresh reads the
// current DB token each time, so a rotation is observed on the next resolution. This mirrors
// ai-price-import's `restResolver`. It gives up the bind-once (#191 lever-2) token-load
// caching of the `callRest` resolver: a job re-reads the token per resolve. That is a cheap
// indexed SELECT (NOT a refresh — the SDK refreshes reactively, in-client), and it is the
// price of not caching creds in memory across rotations. Restoring a per-JOB shared client
// (one rate-limiter bucket per portal per job) is a follow-up (needs a job-scoped seam).
//
// REFRESH RACE — the SDK refreshes OUTSIDE our advisory lock (ensureAccessToken, #35). Two
// concurrent same-portal refreshes can race the rotation: one wins, the other gets
// `invalid_grant`, its job fails, BullMQ retries, the retry re-reads the now-rotated token and
// succeeds. The persist is tombstone-guarded `saveToken` (won't resurrect a purged portal), so
// a lost race is a TRANSIENT retryable failure, never cred corruption. The advisory lock still
// serialises the PROACTIVE keep-alive cron. `QUEUE_SDK_TRANSPORT=0` falls back to the
// advisory-locked `callRest` resolver (portalRestResolver.ts) instantly.

import type { RestCall } from './companyLookup'
import type { PortalRestResolver } from './portalRestResolver'
import { makePortalSdkCall, type SdkPortalDeps } from './b24Sdk'

/**
 * Build a `PortalRestResolver` backed by the SDK transport. Each call builds a fresh
 * per-portal `B24OAuth` (its own rate-limiter bucket + reactive refresh), or resolves `null`
 * when the portal has no stored token (uninstalled / demo). `evict` is a no-op — nothing is
 * cached, so an uninstall is observed naturally on the next resolution (loadToken → null).
 * The `PortalRestResolver` shape matches the `callRest` resolver so the worker swaps between
 * them by an env flag with no other wiring change.
 */
export function createPortalSdkResolver(deps: SdkPortalDeps): PortalRestResolver {
  const resolver = (async (memberId: string): Promise<RestCall | null> => makePortalSdkCall(memberId, deps)) as PortalRestResolver
  resolver.evict = () => {} // nothing cached — fresh client per resolution
  return resolver
}
