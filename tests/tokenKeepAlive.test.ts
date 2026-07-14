import { describe, expect, it, vi } from 'vitest'
import type { PortalToken, QueryFn } from '../server/utils/tokenStore'
import {
  KEEP_ALIVE_THRESHOLD_DAYS,
  MAX_KEEP_ALIVE_BATCH,
  MAX_KEEP_ALIVE_HOURS,
  REFRESH_TOKEN_TTL_DAYS,
  keepAliveIntervalMs,
  nearExpiryCutoffMs,
  runTokenKeepAlive,
  selectTokensNearExpiry,
  type KeepAliveDeps
} from '../server/utils/tokenKeepAlive'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 14) // fixed epoch for deterministic cutoffs

const token = (over: Partial<PortalToken> = {}): PortalToken => ({
  memberId: 'M', domain: 'p.bitrix24.by', accessToken: 'a', refreshToken: 'r',
  expiresAt: NOW - 60_000, applicationToken: '', ...over
})

describe('nearExpiryCutoffMs', () => {
  it('cuts off at TTL - threshold days before now (177d by default)', () => {
    expect(nearExpiryCutoffMs(NOW)).toBe(NOW - (REFRESH_TOKEN_TTL_DAYS - KEEP_ALIVE_THRESHOLD_DAYS) * DAY)
  })
  it('honours custom ttl/threshold', () => {
    expect(nearExpiryCutoffMs(NOW, 30, 5)).toBe(NOW - 25 * DAY)
  })
})

describe('selectTokensNearExpiry', () => {
  it('bounds updated_at to the near-expiry BAND [now-180d, now-177d), oldest first, capped', async () => {
    const query = vi.fn(async () => [{ member_id: 'A' }, { member_id: 'B' }]) as unknown as QueryFn
    const ids = await selectTokensNearExpiry(query, NOW)
    expect(ids).toEqual(['A', 'B'])
    const [sql, params] = (query as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(sql).toMatch(/updated_at < \$1/) // upper: near expiry
    expect(sql).toMatch(/updated_at >= \$2/) // lower: not already past 180d (drops zombies)
    expect(sql).toMatch(/ORDER BY updated_at ASC/)
    expect(sql).toMatch(/LIMIT \$3/)
    expect(params[0]).toBe(new Date(NOW - 177 * DAY).toISOString()) // cutoff (near-expiry)
    expect(params[1]).toBe(new Date(NOW - 180 * DAY).toISOString()) // full-TTL floor
    expect(params[2]).toBe(MAX_KEEP_ALIVE_BATCH) // default cap
  })
  it('passes a custom limit and threshold through (floor tracks the custom ttl)', async () => {
    const query = vi.fn(async () => []) as unknown as QueryFn
    await selectTokensNearExpiry(query, NOW, { limit: 10, thresholdDays: 7, ttlDays: 90 })
    const [, params] = (query as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(params[0]).toBe(new Date(NOW - 83 * DAY).toISOString()) // 90 - 7
    expect(params[1]).toBe(new Date(NOW - 90 * DAY).toISOString()) // full ttl floor
    expect(params[2]).toBe(10)
  })
})

/** Build orchestrator deps with recording fakes. */
function fakeDeps(over: Partial<{
  ids: string[]
  tokens: Record<string, PortalToken | null>
  refresh: (t: PortalToken) => Promise<PortalToken>
}> = {}) {
  const warns: string[] = []
  const logs: string[] = []
  const deps: KeepAliveDeps = {
    now: () => NOW,
    selectNearExpiry: async () => over.ids ?? [],
    getToken: async m => (over.tokens ? (over.tokens[m] ?? null) : token({ memberId: m })),
    // default: refresh bumps expiry by 1h (a fresh pair)
    ensureAccessToken: over.refresh ?? (async t => ({ ...t, expiresAt: NOW + 3_600_000 })),
    warn: m => warns.push(m),
    log: m => logs.push(m)
  }
  return { deps, warns, logs }
}

describe('runTokenKeepAlive', () => {
  it('refreshes every near-expiry portal and counts them', async () => {
    const { deps } = fakeDeps({ ids: ['A', 'B', 'C'] })
    expect(await runTokenKeepAlive(deps)).toEqual({ selected: 3, refreshed: 3, skipped: 0, failed: 0 })
  })

  it('skips a portal that vanished (uninstalled) between select and load', async () => {
    const { deps } = fakeDeps({ ids: ['A', 'B'], tokens: { A: token({ memberId: 'A' }), B: null } })
    expect(await runTokenKeepAlive(deps)).toEqual({ selected: 2, refreshed: 1, skipped: 1, failed: 0 })
  })

  it('counts an unbumped-expiry return as skipped, not refreshed (e.g. portal uninstalled inside the lock)', async () => {
    // ensureAccessToken returns the passed token unchanged (expiry not bumped) — its
    // `!stored` guard when the row vanished under the lock (no save, no rotation).
    const { deps } = fakeDeps({ ids: ['A'], refresh: async t => t })
    expect(await runTokenKeepAlive(deps)).toEqual({ selected: 1, refreshed: 0, skipped: 1, failed: 0 })
  })

  it('isolates a per-portal failure (dead grant) and keeps going', async () => {
    const refresh = vi.fn(async (t: PortalToken) => {
      if (t.memberId === 'B') throw new Error('b24 oauth refresh failed: invalid_grant')
      return { ...t, expiresAt: NOW + 3_600_000 }
    })
    const { deps, warns } = fakeDeps({ ids: ['A', 'B', 'C'], refresh })
    expect(await runTokenKeepAlive(deps)).toEqual({ selected: 3, refreshed: 2, skipped: 0, failed: 1 })
    expect(warns.join()).toMatch(/refresh failed for member B: .*invalid_grant/)
  })

  it('a selection failure propagates (the whole run failed — not swallowed)', async () => {
    const { deps } = fakeDeps()
    deps.selectNearExpiry = async () => {
      throw new Error('db down')
    }
    await expect(runTokenKeepAlive(deps)).rejects.toThrow('db down')
  })

  it('empty selection → all-zero summary, no calls', async () => {
    const { deps } = fakeDeps({ ids: [] })
    expect(await runTokenKeepAlive(deps)).toEqual({ selected: 0, refreshed: 0, skipped: 0, failed: 0 })
  })
})

describe('keepAliveIntervalMs', () => {
  it('defaults to 24h and floors to 1h', () => {
    expect(keepAliveIntervalMs(24)).toBe(24 * 3_600_000)
    expect(keepAliveIntervalMs(0)).toBe(24 * 3_600_000) // invalid → default
    expect(keepAliveIntervalMs(-5)).toBe(24 * 3_600_000)
    expect(keepAliveIntervalMs(1)).toBe(3_600_000)
    expect(keepAliveIntervalMs(2.9)).toBe(2 * 3_600_000) // floored
  })
  it('clamps the upper end so a huge setting cannot overflow setInterval into a 1ms loop', () => {
    const maxMs = MAX_KEEP_ALIVE_HOURS * 3_600_000
    expect(keepAliveIntervalMs(720)).toBe(maxMs) // monthly → clamped to weekly
    expect(keepAliveIntervalMs(100_000)).toBe(maxMs)
    expect(maxMs).toBeLessThan(2_147_483_647) // stays under Node's 32-bit timer ceiling
  })
})

describe('runTokenKeepAlive — saturation warning', () => {
  it('warns when the batch is full (selected === cap)', async () => {
    const ids = Array.from({ length: MAX_KEEP_ALIVE_BATCH }, (_, i) => `p${i}`)
    const { deps, warns } = fakeDeps({ ids })
    const r = await runTokenKeepAlive(deps)
    expect(r.selected).toBe(MAX_KEEP_ALIVE_BATCH)
    expect(warns.some(w => w.includes('saturated'))).toBe(true)
  })
  it('does NOT warn on a partial batch', async () => {
    const { deps, warns } = fakeDeps({ ids: ['A', 'B'] })
    await runTokenKeepAlive(deps)
    expect(warns.some(w => w.includes('saturated'))).toBe(false)
  })
})
