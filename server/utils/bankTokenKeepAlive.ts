// Proactive keep-alive for BANK OAuth tokens (#488/#489).
//
// WHY THIS EXISTS. A bank refresh token is renewed only as a SIDE EFFECT of polling the
// statement: cron tick → bank-fetch job → ensureBankToken → refresh. That makes the lifetime of a
// connection depend on a flag that exists for something else entirely (`CRON_REAL_POLL` is about
// not hammering the bank's STATEMENT API), and every reason polling pauses kills the credentials:
// the flag off (its default), Redis down, the account still `~pending`, a quiet weekend.
//
// This is not theoretical. Measured on production (#488): an Alfa connection made at 13:29 UTC was
// dead by 05:00 the next morning — `invalid_grant`, "Persisted access token data not found". Alfa's
// refresh lives ~10 h, and nothing was renewing it. From outside the connection looked healthy:
// a row in the accounts list, `expires_at` describing the ACCESS token, no error anywhere.
//
// The portal-token side of this was solved long ago (`tokenKeepAlive.ts`, #175) and this module is
// its bank-side twin, with three differences that are not cosmetic:
//
//   1. THE CLOCK IS HOURS, NOT MONTHS. Bitrix refresh lives 180 days and a daily scan is plenty;
//      Alfa's lives ~10 hours, so the scan must run hourly and the near-expiry band is measured in
//      hours too. A daily cadence here would be indistinguishable from doing nothing.
//   2. WE MUST FORCE. `ensureBankToken` refreshes when the ACCESS token is near expiry, which is
//      exactly the wrong signal: the access token can be perfectly fresh while the refresh behind
//      it is minutes from death. Hence `{force: true}` — see `runBankKeepAlive`.
//   3. SOME ACCOUNTS CANNOT BE KEPT ALIVE AT ALL. Prior may issue no refresh token; we store an
//      empty string on purpose (`saveBankToken`). Such a connection dies when its access token
//      does and only a human re-authorising in the bank can revive it. Retrying it forever would
//      burn the bank's rate limit on a request that cannot succeed, so it is EXCLUDED from the
//      scan and counted separately — that count is the thing worth showing an admin.

import type { BankProviderId } from '../../app/types/statement'
import { ALFA_REFRESH_TOKEN_TTL_SEC } from '../../app/utils/alfaOauth'
import type { BankAccountInfo, BankAccountRef, BankToken } from './bankTokenStore'

const HOUR_MS = 3_600_000

/**
 * Refresh-token lifetime per provider, in SECONDS.
 *
 * ⚠ `alfa-by` is the bank's documented figure AND confirmed live (#488): a connection died between
 * hour 10 and hour 16 of idleness. `prior-by` is a deliberate UNDER-estimate, not a measurement —
 * the bank does not document it and we have not observed an expiry. Guessing low costs at most a
 * couple of extra token calls a day per account; guessing high costs a dead connection that only
 * the account owner can revive by logging into their internet bank. When Prior's real figure is
 * measured, raise this and say so here.
 *
 * `manual` has no online token at all — file upload — and never appears in `bank_tokens`; it is
 * present only so the map stays exhaustive over `BankProviderId` (a new bank won't compile until
 * its lifetime is stated).
 */
export const BANK_REFRESH_TTL_SEC: Record<BankProviderId, number> = {
  'alfa-by': ALFA_REFRESH_TOKEN_TTL_SEC,
  'prior-by': 12 * 3600,
  'manual': 0
}

/** Refresh once the token is within this fraction of its life from expiry. 0.2 of Alfa's 10 h is
 *  a 2 h band — comfortably wider than the hourly scan, so a token is always renewed with hours
 *  to spare even if one scan is missed (a restart, a slow tick). */
export const KEEP_ALIVE_BAND = 0.2

/** Max accounts refreshed per run — bounds the burst against the bank's OAuth endpoint the same
 *  way the portal keep-alive bounds Bitrix. Deliberately generous relative to `bank_tokens`
 *  (tens of rows), so saturation means something is wrong, not that we're busy. */
export const MAX_BANK_KEEP_ALIVE_BATCH = 100

/** Default scan cadence in minutes. Must stay well BELOW the narrowest near-expiry band
 *  (Alfa: 2 h) — a scan that runs less often than the band is wide can step over it entirely. */
export const BANK_KEEP_ALIVE_MINUTES = 60
/** Cadence clamp. The lower bound keeps a typo from turning this into a refresh loop against the
 *  bank; the upper bound keeps it meaningfully shorter than Alfa's ~10 h life. */
export const MIN_BANK_KEEP_ALIVE_MINUTES = 5
export const MAX_BANK_KEEP_ALIVE_MINUTES = 240

/** Age (ms) at which a provider's token should be renewed: its lifetime minus the band. */
export function refreshAtAgeMs(provider: BankProviderId, band = KEEP_ALIVE_BAND): number {
  const ttlMs = (BANK_REFRESH_TTL_SEC[provider] ?? 0) * 1000
  return ttlMs * (1 - band)
}

export interface BankKeepAliveSelection {
  /** Accounts to refresh now, oldest first, capped. */
  due: BankAccountRef[]
  /** Connections that CANNOT be kept alive (no stored refresh token) — a human must reconnect. */
  unrefreshable: BankAccountRef[]
}

/**
 * Split the connected accounts into «renew now» and «cannot be renewed», by age of the last
 * successful connect/refresh (`connectedAt` = the row's `updated_at`, stamped by `saveBankToken`
 * on connect AND on every refresh — i.e. exactly "when we last held a fresh pair").
 *
 * Pure over the already-loaded rows: which bank dies when is the fact most likely to be corrected
 * later, and it should be correctable in one table plus one test, not in SQL.
 *
 * ⚠ `~pending` accounts (#407 — connected but the admin hasn't named the account yet) are NOT
 * excluded here, even though the poller skips them. They hold a real token, and the whole point is
 * that the admin can come back tomorrow and finish the setup rather than find a dead connection.
 *
 * ⚠ A provider with a zero lifetime (`manual`, or a bank whose figure is unknown) is skipped, not
 * refreshed constantly: `refreshAtAgeMs` returns 0, and «age ≥ 0» is true for everything.
 */
export function selectBankAccountsNearExpiry(
  rows: readonly BankAccountInfo[],
  nowMs: number,
  opts: { band?: number, limit?: number } = {}
): BankKeepAliveSelection {
  const limit = opts.limit ?? MAX_BANK_KEEP_ALIVE_BATCH
  const due: BankAccountRef[] = []
  const unrefreshable: BankAccountRef[] = []
  const ordered = [...rows].sort((a, b) => a.connectedAt - b.connectedAt)
  for (const row of ordered) {
    const ref: BankAccountRef = { memberId: row.memberId, provider: row.provider, accountKey: row.accountKey }
    if (!row.hasRefresh) {
      unrefreshable.push(ref)
      continue
    }
    const threshold = refreshAtAgeMs(row.provider, opts.band)
    if (threshold <= 0) continue // lifetime unknown/none → don't touch the bank
    const age = nowMs - row.connectedAt
    if (!Number.isFinite(age)) continue // unparsable timestamp → skip rather than refresh blindly
    if (age >= threshold && due.length < limit) due.push(ref)
  }
  return { due, unrefreshable }
}

/** Injected side-effects, so the orchestrator unit-tests without a DB or a bank. */
export interface BankKeepAliveDeps {
  now: () => number
  /** Every connected account with freshness (`listAllBankAccountInfo` bound to the store). */
  listAccounts: () => Promise<BankAccountInfo[]>
  /** Load one account's decrypted token, or null if it vanished (disconnected mid-run). */
  getToken: (ref: BankAccountRef) => Promise<BankToken | null>
  /** Refresh + persist under the per-account advisory lock. MUST be called with `{force:true}`. */
  refresh: (token: BankToken) => Promise<BankToken>
  log?: (msg: string) => void
  warn?: (msg: string) => void
}

export interface BankKeepAliveSummary {
  /** Accounts in the near-expiry band this run. */
  selected: number
  /** Successfully rotated to a fresh pair. */
  refreshed: number
  /** Vanished before load, or already rotated by a concurrent poll (idempotent). */
  skipped: number
  /** Refresh rejected by the bank — logged, not fatal; the account needs reconnecting. */
  failed: number
  /** Connections with no stored refresh token at all — cannot be kept alive by anyone. */
  unrefreshable: number
}

/** Account keys can carry an IBAN; clamp + strip before logging (defence-in-depth, PRIVACY §Логи). */
function logSafeKey(v: string): string {
  return v.replace(/[^\w.~:-]/g, '').slice(0, 40)
}

/**
 * Renew every near-expiry bank connection ONCE, isolating per-account failures — one dead grant
 * must not stop the rest, nor crash the cron. Only a failure of the initial listing propagates.
 */
export async function runBankKeepAlive(deps: BankKeepAliveDeps): Promise<BankKeepAliveSummary> {
  const rows = await deps.listAccounts()
  const { due, unrefreshable } = selectBankAccountsNearExpiry(rows, deps.now())
  const s: BankKeepAliveSummary = {
    selected: due.length, refreshed: 0, skipped: 0, failed: 0, unrefreshable: unrefreshable.length
  }
  if (due.length >= MAX_BANK_KEEP_ALIVE_BATCH) {
    deps.warn?.(`[bank-keepalive] batch saturated (${due.length} ≥ cap ${MAX_BANK_KEEP_ALIVE_BATCH}) — some connections may expire before the next run`)
  }
  for (const ref of due) {
    try {
      const token = await deps.getToken(ref)
      if (!token) {
        s.skipped++ // disconnected between listing and load
        continue
      }
      const before = token.expiresAt
      const updated = await deps.refresh(token)
      // A bumped ACCESS expiry proves the pair rotated — either by us, or by a poll that won the
      // same advisory lock while we waited. Both outcomes leave a fresh refresh token behind.
      if (updated.expiresAt > before) s.refreshed++
      else s.skipped++
    } catch (e) {
      s.failed++
      deps.warn?.(`[bank-keepalive] refresh failed for ${ref.provider}/${logSafeKey(ref.accountKey)}: ${(e as { message?: string })?.message ?? String(e)}`)
    }
  }
  // The unrefreshable count is the actionable half of this log line: it names connections that no
  // amount of retrying will fix, and that nobody is otherwise told about.
  if (unrefreshable.length > 0) {
    deps.warn?.(`[bank-keepalive] ${unrefreshable.length} connection(s) have NO refresh token — they die with their access token and need reconnecting: ${unrefreshable.map(r => `${r.provider}/${logSafeKey(r.accountKey)}`).join(', ')}`)
  }
  deps.log?.(`[bank-keepalive] selected=${s.selected} refreshed=${s.refreshed} skipped=${s.skipped} failed=${s.failed} unrefreshable=${s.unrefreshable}`)
  return s
}

/** Scan cadence in ms from a minutes setting, clamped. Pure. */
export function bankKeepAliveIntervalMs(minutes: number): number {
  const m = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : BANK_KEEP_ALIVE_MINUTES
  return Math.min(MAX_BANK_KEEP_ALIVE_MINUTES, Math.max(MIN_BANK_KEEP_ALIVE_MINUTES, m)) * 60_000
}

/** Sanity bound used by the wiring: the scan must be shorter than the narrowest band, or it can
 *  step over a token's near-expiry window entirely. Exported so a test can assert the default. */
export function narrowestBandMs(): number {
  const bands = (Object.keys(BANK_REFRESH_TTL_SEC) as BankProviderId[])
    .map(p => refreshAtAgeMs(p))
    .filter(v => v > 0)
    .map(v => v * (KEEP_ALIVE_BAND / (1 - KEEP_ALIVE_BAND)))
  return bands.length ? Math.min(...bands) : HOUR_MS
}
