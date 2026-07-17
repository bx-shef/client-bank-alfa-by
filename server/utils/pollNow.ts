// Manual «Опросить сейчас» — guarded on-demand bank poll for testing/debugging (#54). Pure
// logic over injected I/O (DI), unit-testable without Redis/DB/B24. The thin route
// (server/api/poll-now.post.ts) wires the live transports + mints now/window.
//
// #54 is explicit that poll frequency is regulated APP-SIDE, never by a portal user/admin —
// a portal admin must not be able to outrun the bank's rate limit (a ban hits the shared app).
// This endpoint honours that with four layers, none of which the caller controls:
//   1. FEATURE GATE — `enabled` (env MANUAL_POLL_ENABLED, default OFF): the owner decides whether
//      portals get the button at all. Off ⇒ 503 before anything.
//   2. ADMIN GATE — the frame token must belong to THIS portal (blocks X-B24-Domain spoofing) and
//      the caller must be a portal admin.
//   3. PER-PORTAL COOLDOWN — a Redis NX-EX slot (`claimSlot`): within the cooldown a repeat poll is
//      429'd, so the button can't be hammered to exceed the bank rate. Only claimed when there is
//      real work (≥1 connected account), so a no-op poll doesn't burn the window.
//   4. GLOBAL RATE-LIMITER (A8) — the bank-fetch queue's fleet-wide limiter still caps the actual
//      Alfa calls downstream, and idempotent fetch jobIds absorb double-clicks within a tick.
// It only ever polls the caller's OWN portal's connected accounts (listAccounts is member-scoped).

import { accountsForPolling, planFetches, pollWindow } from '../queue/cron'
import type { FetchJob } from '../queue/topology'
import type { BankAccountRef } from './bankTokenStore'

export interface PollNowResult {
  status: number
  body: Record<string, unknown>
}

export interface PollNowDeps {
  /** Feature gate — env MANUAL_POLL_ENABLED (default OFF) AND queues enabled. Off ⇒ 503. */
  enabled: boolean
  /** Cooldown length (seconds) for the per-portal manual-poll slot. */
  cooldownSec: number
  /** Statement lookback window (days) — same rolling window the cron poll uses. */
  lookbackDays: number
  /** member_id of the portal we hold tokens for, by domain; null if not installed. */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Validate the frame token against `domain` (`profile`), returning the user's admin flag, or
   *  THROWING if the token isn't valid for that portal (blocks domain spoofing). */
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** The portal's connected bank accounts (member-scoped — never another portal's). */
  listAccounts: (memberId: string) => Promise<BankAccountRef[]>
  /** Claim the per-portal cooldown slot (Redis NX-EX). true ⇒ proceed; false ⇒ still cooling down. */
  claimSlot: (memberId: string, ttlSec: number) => Promise<boolean>
  /** Enqueue one bank-fetch job (idempotent jobId absorbs double-enqueue within a tick). The
   *  return is ignored (enqueueFetch resolves a boolean; no-ops false without Redis). */
  enqueue: (job: FetchJob) => Promise<unknown>
  /** Now, epoch ms — used for the poll window AND the fetch `epoch` (a fresh fetch, not deduped). */
  nowMs: number
}

export interface PollNowInput {
  accessToken: string
  domain: string
}

/** Default manual-poll cooldown (seconds): a manual test poll no more than once per minute per
 *  portal — comfortably below any bank rate limit even before the global limiter. */
export const DEFAULT_MANUAL_POLL_COOLDOWN_SEC = 60

/**
 * Handle a manual poll request. Returns 200 `{enqueued, accounts, cooldownSec}` on success, or a
 * 4xx/5xx `{error}`. Enqueues one bank-fetch job per connected pollable account for a rolling
 * window; inert (200, enqueued:0) when the portal has no connected accounts yet.
 */
export async function handlePollNow(deps: PollNowDeps, input: PollNowInput): Promise<PollNowResult> {
  if (!deps.enabled) return { status: 503, body: { error: 'manual poll disabled' } }

  const { accessToken, domain } = input
  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }

  // Portal key check — do we hold tokens for this domain's portal?
  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed (no key)' } }

  // Prove the frame token belongs to THIS portal (blocks X-B24-Domain spoofing) AND read admin.
  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token for this portal' } }
  }
  // Admin-only: a manual poll is an operator/test action, not a regular user feature (#54).
  if (!frame.isAdmin) return { status: 403, body: { error: 'manual poll requires a portal administrator' } }

  // Only poll accounts of THIS portal, filtered to pollable providers (drops Prior until A5b / demo).
  const accounts = await deps.listAccounts(memberId)
  const byPortal = accountsForPolling(accounts)
  const pollable = byPortal.reduce((n, p) => n + p.accounts.length, 0)
  // No connected accounts yet → nothing to do; do NOT burn the cooldown on a no-op.
  if (pollable === 0) return { status: 200, body: { enqueued: 0, accounts: 0 } }

  // Per-portal cooldown: reject a too-soon repeat so the button can't outrun the bank rate.
  const claimed = await deps.claimSlot(memberId, deps.cooldownSec)
  if (!claimed) {
    return { status: 429, body: { error: 'manual poll on cooldown', cooldownSec: deps.cooldownSec } }
  }

  // Fresh fetch: `epoch` = now, so the fetch jobId is distinct from a same-window cron poll and
  // actually re-fetches (crm-sync still dedupes writes by the B24 marker).
  const { dateFrom, dateTo } = pollWindow(new Date(deps.nowMs), deps.lookbackDays)
  const jobs = planFetches(byPortal, dateFrom, dateTo, String(deps.nowMs))
  for (const job of jobs) await deps.enqueue(job)

  return { status: 200, body: { enqueued: jobs.length, accounts: pollable, cooldownSec: deps.cooldownSec } }
}
