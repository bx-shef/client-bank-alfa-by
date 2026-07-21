// In-process fixed-window rate limiter for the operator login route. In the main prod path
// nginx throttles `/api/auth/login` (zone `login`, ~10r/m per client IP, #64); the Vibecode
// Black Hole deploy has no nginx, so a single shared operator password would face un-throttled
// brute force. This is an in-MEMORY backstop for that no-nginx case — gated by the same
// `SECURITY_HEADERS_ENABLED` flag as the security headers, so the nginx path is unchanged.
//
// Scope/limits (honest): per-process only (not shared across replicas) and resets on restart —
// fine for the single-process Black Hole target; it is NOT a substitute for nginx's limiter in
// the scaled prod path (which keeps its own). Keyed by client IP; a fixed window keeps it simple
// and allocation-light (no per-request timers).

export interface RateLimitDecision {
  allowed: boolean
  /** Seconds until the current window resets (for a `Retry-After` header). 0 when allowed. */
  retryAfterSec: number
}

export interface RateLimiter {
  check: (key: string, nowMs: number) => RateLimitDecision
}

/** Create a fixed-window limiter allowing `max` hits per `windowMs` per key. The bucket map is
 *  swept lazily (a key whose window elapsed is reset on its next hit), and fully pruned whenever
 *  it grows past `maxKeys` to bound memory under IP-spray. Pure over an injected clock via the
 *  `nowMs` arg — unit-testable without real time.
 *
 *  `globalMax` (optional) adds a SECOND ceiling across ALL keys in the same window. The per-key
 *  key is `X-Forwarded-For`, which is client-controlled — an attacker rotating a fake first hop
 *  gets a fresh per-key bucket every request and would bypass the per-IP limit entirely. The
 *  global cap catches that: a spray still hits a wall. Set it well above the per-key limit so a
 *  handful of legit operators never trip it, but low enough to blunt distributed brute force. */
export function createRateLimiter(opts: { windowMs: number, max: number, maxKeys?: number, globalMax?: number }): RateLimiter {
  const windowMs = Math.max(1, Math.floor(opts.windowMs))
  const max = Math.max(1, Math.floor(opts.max))
  const maxKeys = Math.max(1, Math.floor(opts.maxKeys ?? 10_000))
  const globalMax = opts.globalMax !== undefined ? Math.max(1, Math.floor(opts.globalMax)) : undefined
  const buckets = new Map<string, { count: number, resetAt: number }>()
  let global = { count: 0, resetAt: 0 }

  return {
    check(key: string, nowMs: number): RateLimitDecision {
      // Memory backstop: if the map blew past the cap (spray of unique IPs), drop expired
      // entries; if still over, clear it wholesale (a reset is safe — worst case a few callers
      // get a fresh window). Cheap amortised cleanup without a background timer.
      if (buckets.size > maxKeys) {
        for (const [k, b] of buckets) {
          if (b.resetAt <= nowMs) buckets.delete(k)
        }
        if (buckets.size > maxKeys) buckets.clear()
      }

      // Global ceiling (XFF-spoof backstop): checked FIRST and does not consume the per-key
      // budget when it blocks. Roll the window if elapsed.
      if (globalMax !== undefined) {
        if (global.resetAt <= nowMs) global = { count: 0, resetAt: nowMs + windowMs }
        if (global.count >= globalMax) {
          return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((global.resetAt - nowMs) / 1000)) }
        }
      }

      const cur = buckets.get(key)
      const perKeyBlocked = cur && cur.resetAt > nowMs && cur.count >= max
      if (perKeyBlocked) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((cur!.resetAt - nowMs) / 1000)) }
      }

      // Allowed: consume BOTH budgets.
      if (!cur || cur.resetAt <= nowMs) buckets.set(key, { count: 1, resetAt: nowMs + windowMs })
      else cur.count++
      if (globalMax !== undefined) global.count++
      return { allowed: true, retryAfterSec: 0 }
    }
  }
}

/** Extract the client IP for keying: first hop of `X-Forwarded-For` (the real client when a
 *  proxy/tunnel is in front, as in Black Hole), else the remote address, else a constant so a
 *  header-less caller still shares one bucket (fail-safe toward limiting, not bypass). */
export function clientIpKey(forwardedFor: string | undefined, remote: string | undefined): string {
  const fwd = (forwardedFor ?? '').split(',')[0]?.trim()
  if (fwd) return fwd
  const r = (remote ?? '').trim()
  return r || 'unknown'
}
