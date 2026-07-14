// Proactive OAuth keep-alive (#175). Bitrix `refresh_token` lives ~180 days; the
// lazy refresh (ensureAccessToken) only fires on a REST call, so a portal that is
// installed but idle (no bank accounts configured, no polling) makes NO calls and its
// refresh_token silently dies on day 180 — the portal is lost until a user reinstalls.
//
// This adds a SECOND path: once a day, refresh ONLY the portals whose refresh_token is
// within a few days of expiry (age of the last saved token pair > ~177 days). We key
// off `portal_tokens.updated_at`, which `saveToken` stamps on every install AND every
// refresh (the sole writer), so it is exactly "when we last got a fresh pair".
//
// DELIBERATELY conservative (B24 warns that frequent refreshing risks an app auto-block):
// a daily scan, a small batch cap, and only near-expiry portals — never "refresh all".
// The actual refresh reuses `ensureAccessToken` (per-portal advisory lock + re-read +
// single-writer save), so this path and the lazy path can't race on the rotating token.

import type { PortalToken, QueryFn } from './tokenStore'

/** Bitrix `refresh_token` lifetime (official: 180 days). */
export const REFRESH_TOKEN_TTL_DAYS = 180
/** Refresh when the token is within this many days of expiry (age > TTL - threshold). */
export const KEEP_ALIVE_THRESHOLD_DAYS = 3
/** Max portals refreshed per daily run — bound the burst on the OAuth server. */
export const MAX_KEEP_ALIVE_BATCH = 50
/** Upper bound for the run cadence (weekly). The near-expiry window is only ~3 days, so a
 *  cadence longer than that risks missing portals; it also keeps `setInterval` well under
 *  Node's 2^31-1 ms timer ceiling (a larger delay is silently clamped to 1 ms → a tight loop). */
export const MAX_KEEP_ALIVE_HOURS = 168

const DAY_MS = 86_400_000

export interface NearExpiryOpts {
  ttlDays?: number
  thresholdDays?: number
  limit?: number
}

/** The `updated_at` cutoff: a token last saved before this is near refresh-expiry.
 *  Pure (nowMs injected) so the selection window is unit-testable. */
export function nearExpiryCutoffMs(nowMs: number, ttlDays = REFRESH_TOKEN_TTL_DAYS, thresholdDays = KEEP_ALIVE_THRESHOLD_DAYS): number {
  return nowMs - (ttlDays - thresholdDays) * DAY_MS
}

/**
 * Select the portals in the ~3-day near-expiry BAND — `updated_at` older than the
 * cutoff (near expiry) BUT not older than the full TTL (still refreshable) — oldest
 * first, capped at `limit`. The lower bound matters: a grant that dies WITHOUT an
 * uninstall event (revoked / trial lapsed / already past 180d) keeps a frozen, ever-older
 * `updated_at` (a failed refresh never re-stamps it) and would otherwise sort oldest-first
 * and monopolise the capped batch forever, starving live near-expiry portals. Bounding the
 * window to [now-TTL, now-cutoff) drops such a row after ~`thresholdDays` runs and skips
 * definitively-expired grants (no point refreshing a token already past 180d). Cheap
 * index-friendly range scan; returns bare member_ids. Pure over the injected `QueryFn`.
 */
export async function selectTokensNearExpiry(query: QueryFn, nowMs: number, opts: NearExpiryOpts = {}): Promise<string[]> {
  const ttlDays = opts.ttlDays ?? REFRESH_TOKEN_TTL_DAYS
  const cutoff = new Date(nearExpiryCutoffMs(nowMs, ttlDays, opts.thresholdDays)).toISOString()
  const windowStart = new Date(nowMs - ttlDays * DAY_MS).toISOString() // full-TTL floor: older = already dead
  const limit = opts.limit ?? MAX_KEEP_ALIVE_BATCH
  const rows = await query(
    `SELECT member_id FROM portal_tokens
       WHERE updated_at < $1::timestamptz AND updated_at >= $2::timestamptz
       ORDER BY updated_at ASC LIMIT $3`,
    [cutoff, windowStart, limit]
  )
  return rows.map(r => String(r.member_id))
}

/** Injected side-effects — so the orchestrator unit-tests without DB/network. */
export interface KeepAliveDeps {
  now: () => number
  /** Portals near refresh-expiry (`selectTokensNearExpiry` bound to the store). */
  selectNearExpiry: (nowMs: number) => Promise<string[]>
  /** Load a portal's decrypted token, or null if it vanished (uninstalled). */
  getToken: (memberId: string) => Promise<PortalToken | null>
  /** Refresh + persist under the per-portal lock. Reuses `ensureAccessToken`: an idle
   *  near-expiry portal's access token expired long ago, so this always rotates the pair
   *  (and re-stamps `updated_at`, resetting the 180-day clock). Throws on a dead grant. */
  ensureAccessToken: (token: PortalToken) => Promise<PortalToken>
  log?: (msg: string) => void
  warn?: (msg: string) => void
}

export interface KeepAliveSummary {
  /** Portals that were near expiry this run. */
  selected: number
  /** Successfully rotated to a fresh pair. */
  refreshed: number
  /** Vanished before load, or already refreshed by a concurrent path (idempotent). */
  skipped: number
  /** Refresh rejected (dead/expired grant, app removed, PAYMENT_REQUIRED) — logged, not fatal. */
  failed: number
}

/** member_id is a B24-issued hex id; clamp + strip control chars before logging (defence-in-depth). */
function logSafeMember(id: string): string {
  return id.replace(/[^\w.-]/g, '').slice(0, 64)
}

/**
 * Refresh every near-expiry portal ONCE, isolating per-portal failures (a dead grant on
 * one portal must not stop the rest, nor crash the cron). Returns a summary for the log /
 * a future metric. Never throws for a single portal's failure — only a failure of the
 * initial selection propagates.
 */
export async function runTokenKeepAlive(deps: KeepAliveDeps): Promise<KeepAliveSummary> {
  const ids = await deps.selectNearExpiry(deps.now())
  const s: KeepAliveSummary = { selected: ids.length, refreshed: 0, skipped: 0, failed: 0 }
  // A full batch means the near-expiry band has ≥ the cap: the backlog may not clear within
  // the ~3-day window before day 180. Surface it (alertable) rather than silently truncating.
  if (ids.length >= MAX_KEEP_ALIVE_BATCH) {
    deps.warn?.(`[keepalive] batch saturated (selected=${ids.length} ≥ cap ${MAX_KEEP_ALIVE_BATCH}) — near-expiry backlog may exceed one run; raise the cap/threshold`)
  }
  for (const memberId of ids) {
    try {
      const token = await deps.getToken(memberId)
      if (!token) {
        s.skipped++ // uninstalled between select and load — nothing to keep alive
        continue
      }
      const before = token.expiresAt
      const updated = await deps.ensureAccessToken(token)
      // A bumped expiry ⇒ we (or a concurrent lazy refresh under the same lock) rotated it.
      if (updated.expiresAt > before) s.refreshed++
      else s.skipped++
    } catch (e) {
      // Dead refresh_token (invalid_grant), removed app, expired trial (PAYMENT_REQUIRED),
      // etc. Log loud (alertable) and carry on — the portal needs a reinstall; that's the
      // user's action, and one bad portal must not block the others.
      s.failed++
      deps.warn?.(`[keepalive] refresh failed for member ${logSafeMember(memberId)}: ${(e as { message?: string })?.message ?? String(e)}`)
    }
  }
  deps.log?.(`[keepalive] selected=${s.selected} refreshed=${s.refreshed} skipped=${s.skipped} failed=${s.failed}`)
  return s
}

/** Keep-alive interval in ms from an hours setting. Clamped to [1h, MAX_KEEP_ALIVE_HOURS];
 *  default 24h. The upper clamp is essential: an unbounded value overflows `setInterval`'s
 *  2^31-1 ms ceiling, which Node silently clamps to 1 ms → a tight refresh loop. Pure. */
export function keepAliveIntervalMs(hours: number): number {
  const h = Number.isFinite(hours) && hours > 0 ? Math.floor(hours) : 24
  return Math.min(Math.max(1, h), MAX_KEEP_ALIVE_HOURS) * 3_600_000
}
