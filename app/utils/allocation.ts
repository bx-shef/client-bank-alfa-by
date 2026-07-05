import type { StatementItem } from '~/types/statement'
import { dedupKey } from '~/utils/statement'

// Pure allocation core (#109): decide whether an incoming payment unambiguously
// closes exactly one CRM target — a Smart Invoice or a deal payment — under the
// owner's free-tier criterion "ровно 1 кандидат, где сходятся и сумма, и валюта"
// (see docs/PROCESSING.md §2 «Что выбираем»). No I/O: the caller supplies the
// candidates already FILTERED BY COMPANY (my company + the counterparty company,
// Stage C/D), and this module never looks anything up by an arbitrary id — so it
// can never touch a target outside the resolved companies. Fully unit-tested.

/** The kind of CRM entity a payment can be allocated to. `order` is not a target
 *  of its own — it is only a way to FIND a deal payment (see PROCESSING.md §2). */
export type AllocationTargetKind = 'invoice' | 'deal-payment'

/** A candidate entity a payment might close, already scoped to the resolved
 *  companies. `amount`/`currency` are the entity's own; matching is exact. */
export interface AllocationCandidate {
  kind: AllocationTargetKind
  /** CRM id of the entity (invoice id or deal-payment id), as a string. */
  id: string
  /** Entity amount (positive). Compared to the payment in exact minor units. */
  amount: number
  /** ISO currency code of the entity, e.g. `BYN`. */
  currency: string
  /** For an invoice: the deal it belongs to (`parentId`). Lets us recognise an
   *  invoice and a deal payment as ONE target in two representations. */
  dealId?: string
}

/** Input to the decision: the payment (from the statement) plus its candidates. */
export interface AllocationInput {
  amount: number
  currency: string
  candidates: readonly AllocationCandidate[]
}

/** The decision. Discriminated by `action`:
 *  - `allocate` — exactly one eligible target; mark it paid / fire the trigger.
 *  - `none` — no candidates at all for the companies; record a plain дело.
 *  - `manual` — candidates exist but not an unambiguous single match (partial /
 *    group payment, currency/amount mismatch, or several distinct targets) →
 *    «очередь ручного разбора» + notify. `reason` explains which. */
export type AllocationDecision
  = | { action: 'allocate', target: AllocationCandidate }
    | { action: 'none', reason: 'no-candidates' }
    | { action: 'manual', reason: ManualReason, candidates: AllocationCandidate[] }

/** Why a payment could not be auto-allocated. */
export type ManualReason = 'no-exact-match' | 'multiple-candidates'

/** Convert a money amount to integer minor units for exact comparison — floats
 *  like `0.1 + 0.2` never compare equal, so round to the nearest cent. */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100)
}

/** Case-insensitive ISO currency-code equality (trimmed). */
export function sameCurrency(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase()
}

/** A candidate is eligible only when BOTH its currency AND its amount match the
 *  payment exactly (owner's free-tier criterion). Partial/group payments — where
 *  the amount differs — are excluded here and surface as `manual` downstream. */
export function isEligible(payment: AllocationInput, c: AllocationCandidate): boolean {
  return sameCurrency(payment.currency, c.currency)
    && toMinorUnits(payment.amount) === toMinorUnits(c.amount)
}

/**
 * Collapse candidates that are really the SAME target seen twice:
 *  1. An invoice and a deal payment where the invoice's `dealId` equals the
 *     deal-payment id — two representations of one deal's payment → keep the
 *     INVOICE (preferred per §2), drop the payment.
 *  2. Full duplicates of one entity (same kind|currency|amount) → keep the
 *     smallest id (stable tie-break).
 * The result is the list of DISTINCT targets left to choose between.
 */
export function collapseSameTarget(candidates: readonly AllocationCandidate[]): AllocationCandidate[] {
  // Deal ids that an eligible invoice already covers — their deal-payments fold in.
  const invoiceDealIds = new Set(
    candidates.filter(c => c.kind === 'invoice' && c.dealId).map(c => c.dealId as string)
  )
  const kept: AllocationCandidate[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    // A deal payment whose deal is covered by an invoice is the same target → skip.
    if (c.kind === 'deal-payment' && invoiceDealIds.has(c.id)) continue
    // Full duplicates: identical kind|currency|amount → keep only the smallest id.
    const dupeKey = `${c.kind}|${c.currency.trim().toUpperCase()}|${toMinorUnits(c.amount)}`
    const prevIdx = kept.findIndex(k => `${k.kind}|${k.currency.trim().toUpperCase()}|${toMinorUnits(k.amount)}` === dupeKey)
    if (prevIdx >= 0) {
      if (compareIds(c.id, kept[prevIdx]!.id) < 0) kept[prevIdx] = c
      continue
    }
    if (!seen.has(c.id)) {
      seen.add(c.id)
      kept.push(c)
    }
  }
  return kept
}

/** Compare CRM ids numerically when both are numeric, else lexicographically —
 *  so `id 9` sorts before `id 10` (min-id tie-break must be numeric-aware). */
export function compareIds(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Decide how to allocate one payment against its (company-scoped) candidates.
 * Conservative default (#109): auto-allocate ONLY when exactly one distinct
 * target matches both amount and currency; anything ambiguous goes to manual.
 */
export function resolveAllocation(input: AllocationInput): AllocationDecision {
  const eligible = input.candidates.filter(c => isEligible(input, c))
  if (eligible.length === 0) {
    // No candidates at all → nothing to allocate to (record a plain дело).
    // Candidates exist but none match exactly (partial/group/mismatch) → manual.
    return input.candidates.length === 0
      ? { action: 'none', reason: 'no-candidates' }
      : { action: 'manual', reason: 'no-exact-match', candidates: [...input.candidates] }
  }
  const distinct = collapseSameTarget(eligible)
  if (distinct.length === 1) return { action: 'allocate', target: distinct[0]! }
  return { action: 'manual', reason: 'multiple-candidates', candidates: distinct }
}

/**
 * Idempotency key for the persistent allocation fact «этот платёж → эта сущность»
 * (#109): payment dedup key + target kind + target id. Stable for the same
 * (payment, target) so a redelivery/reimport is recognised and not applied twice;
 * the fact carries a status (`разнесён`/`откат`), stored separately (follow-up),
 * not a literal write-once clone. Scoped by `member_id` at the store layer.
 */
export function allocationFactKey(
  payment: Pick<StatementItem, 'account' | 'docId'>,
  target: Pick<AllocationCandidate, 'kind' | 'id'>
): string {
  return `${dedupKey(payment)}|${target.kind}|${target.id}`
}
