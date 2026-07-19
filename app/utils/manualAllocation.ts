// Pure core for MANUAL payment distribution (#109, PROCESSING.md §3). An incoming payment
// (the smart-process element's amount) is split across targets (deal-payments / invoices) in
// PARTIAL amounts — unlike the auto path (`resolveAllocation`), which needs an exact full match.
//
// Modeled on the sibling app `aidapioneer-tech/sync-payments` (the reference for the visual):
// there each distribution is a CHILD smart-process item (`opportunity` = amount, link to the
// payment) and «осталось распределить» is a field on the element = amount − Σ distributions.
// This module is STORAGE-AGNOSTIC: it computes over a list of distribution entries, whether they
// live as B24 child items (recommended) or in our fact store — the transport is a later slice.
// No I/O. Money is rounded via `money.round2` (no IEEE-754 drift); comparisons tolerate a
// half-kopeck epsilon so a legit "distribute the exact remainder" isn't rejected by float noise.

import { round2 } from './money'
import type { AllocationTargetKind } from './allocation'

/** How a distribution was made: `auto` (import-time) vs `manual` (operator from the element).
 *  §3: after an AUTO allocation a later external change is ignored; after a MANUAL one it flags
 *  the element «требует распределения». So the source must travel with the entry. */
export type AllocationSource = 'auto' | 'manual'

/** `active` counts toward «распределено»; `reverted` is kept for history but frees the amount. */
export type DistributionStatus = 'active' | 'reverted'

/** One committed distribution of part of a payment to a target (mirrors a sync-payments
 *  «распределение» child item: `opportunity`=amount, links to the payment + parent element). */
export interface DistributionEntry {
  targetKind: AllocationTargetKind
  targetId: string
  amount: number
  currency: string
  source: AllocationSource
  status: DistributionStatus
}

/** Footer summary of a payment's distribution state (mirrors sync-payments: total /
 *  needDistributionsSum / distributionsSum + the over-limit flag). */
export interface DistributionSummary {
  /** The payment's full amount (element `opportunity`). */
  total: number
  /** Σ of ACTIVE, same-currency entries (rounded). */
  distributed: number
  /** `total − distributed`, clamped to ≥ 0 (never show a negative remainder). */
  remaining: number
  /** True when active distributions exceed the total (over-allocated — a bug/edit to fix). */
  overLimit: boolean
}

/** Half a kopeck — the tolerance for money comparisons after `round2`. */
const EPSILON = 0.005

/** Is `entry` currently taking money (active + matches the payment currency)? A different-currency
 *  entry never counts toward the total (currencies don't add). */
function counts(entry: DistributionEntry, currency: string): boolean {
  return entry.status === 'active' && entry.currency === currency
}

/**
 * Summarize a payment's distribution state: how much of `total` (in `currency`) is already
 * distributed by the active entries, and how much remains. `total`/amounts are rounded; a
 * non-finite total is treated as 0 (via `round2`).
 */
export function distributionSummary(total: number, currency: string, entries: readonly DistributionEntry[]): DistributionSummary {
  // Clamp to ≥0: a negative payment total is a bad input (an incoming amount is never negative);
  // without this an empty ledger over a negative total would spuriously read `overLimit` (0 − (−x)).
  const totalR = Math.max(0, round2(total))
  const distributed = round2(entries.reduce((sum, e) => (counts(e, currency) ? sum + round2(e.amount) : sum), 0))
  const remaining = round2(Math.max(0, totalR - distributed))
  return { total: totalR, distributed, remaining, overLimit: distributed - totalR > EPSILON }
}

/** Why a proposed manual allocation is rejected (for a UI message), or `null` when it's OK. */
export type AllocationReject
  = | 'currency-mismatch' // candidate currency ≠ payment currency
    | 'non-positive' // amount ≤ 0
    | 'exceeds-target' // amount > the target's own cap (e.g. the deal-payment's sum)
    | 'exceeds-remaining' // amount > what's left to distribute

/**
 * Validate a single proposed manual allocation against the current remaining. `candidate.max`
 * is the target's own ceiling (e.g. the deal-payment `sum`), optional. Pure — the caller
 * (or `distributionSummary`) supplies `remaining`. Returns `null` if allowed, else the reason.
 */
export function validateAllocation(
  remaining: number,
  paymentCurrency: string,
  candidate: { amount: number, currency: string, max?: number }
): AllocationReject | null {
  if (candidate.currency !== paymentCurrency) return 'currency-mismatch'
  const amount = round2(candidate.amount)
  if (amount <= 0) return 'non-positive'
  if (candidate.max !== undefined && amount - round2(candidate.max) > EPSILON) return 'exceeds-target'
  if (amount - round2(remaining) > EPSILON) return 'exceeds-remaining'
  return null
}

/** Result of validating a whole pending PLAN (several per-target inputs at once — the sync-payments
 *  footer: Σ inputs must not exceed `remaining`; each input must be individually valid). */
export interface PlanValidation {
  /** Σ of the plan's amounts (rounded) — the «Вы хотите распределить». */
  wantDistribute: number
  /** True when the plan's sum exceeds `remaining` (the over-limit `B24Advice`). */
  overLimit: boolean
  /** Per-line reject reason (same index as the input plan), `null` where the line is fine. */
  lineRejects: (AllocationReject | null)[]
  /** True when nothing is rejected AND wantDistribute > 0 (the «Распределить» enable condition). */
  ok: boolean
}

/**
 * Validate a whole pending distribution plan (the sync-payments «Распределить» gate). Each line is
 * checked individually (currency / positive / ≤ its own max) AND the plan's TOTAL must fit the
 * remaining. `ok` mirrors their button-enable: `wantDistribute > 0 && !overLimit && no line rejects`.
 */
export function validatePlan(
  remaining: number,
  paymentCurrency: string,
  plan: readonly { amount: number, currency: string, max?: number }[]
): PlanValidation {
  const remainingR = round2(remaining)
  const wantDistribute = round2(plan.reduce((sum, p) => sum + round2(p.amount), 0))
  // Per-line check ignores the plan-total (that's the separate over-limit gate) — a line is
  // rejected only for its OWN faults (currency / non-positive / exceeds its target cap).
  const lineRejects = plan.map((p) => {
    if (p.currency !== paymentCurrency) return 'currency-mismatch' as const
    const amount = round2(p.amount)
    if (amount <= 0) return 'non-positive' as const
    if (p.max !== undefined && amount - round2(p.max) > EPSILON) return 'exceeds-target' as const
    return null
  })
  const overLimit = wantDistribute - remainingR > EPSILON
  const ok = wantDistribute > 0 && !overLimit && lineRejects.every(r => r === null)
  return { wantDistribute, overLimit, lineRejects, ok }
}

/** Outcome of reconciling a stored ledger against live CRM state (§3 «Реакция на изменения»). */
export interface Reconciliation {
  /** Entries whose target is still live — kept active. */
  kept: DistributionEntry[]
  /** Entries whose target vanished / was un-applied — flipped to `reverted` (amount freed). */
  dropped: DistributionEntry[]
  /** True when at least one MANUAL entry was dropped → the element must be re-distributed (§3:
   *  a manual allocation whose target changed requires the operator to redistribute; an AUTO
   *  one is ignored, so an auto drop does NOT raise this flag). */
  needsRedistribution: boolean
}

/**
 * Reconcile a ledger against live CRM state (#109 §3, entity-deletion / un-pay handling). Any
 * active entry whose target is no longer "live" (deleted, or the payment un-paid / invoice stage
 * moved off paid) is flipped to `reverted` (its amount returns to «осталось распределить»).
 * `isTargetLive(kind, id)` is the injected liveness probe (the REST read is the transport slice).
 * Per §3, only a dropped MANUAL entry sets `needsRedistribution`; auto drops are silent.
 */
export function reconcile(
  entries: readonly DistributionEntry[],
  isTargetLive: (kind: AllocationTargetKind, id: string) => boolean
): Reconciliation {
  const kept: DistributionEntry[] = []
  const dropped: DistributionEntry[] = []
  for (const e of entries) {
    if (e.status !== 'active') {
      kept.push(e) // already reverted — leave as-is (history)
      continue
    }
    if (isTargetLive(e.targetKind, e.targetId)) kept.push(e)
    else dropped.push({ ...e, status: 'reverted' })
  }
  return { kept, dropped, needsRedistribution: dropped.some(e => e.source === 'manual') }
}
