import type { StatementItem } from '~/types/statement'
import { dedupKey } from '~/utils/statement'

// Pure allocation core (#109): decide how an incoming payment closes a CRM target
// found by SEARCH — a Smart Invoice or a deal payment — under the owner's rules
// (see docs/PROCESSING.md §2 «Что выбираем»). Eligible = amount AND currency match
// exactly. When several match, allocate to the SMALLEST id and flag `ambiguous`
// so the caller posts a heads-up to the chat. No I/O: the caller supplies the
// candidates already FILTERED BY COMPANY (my company + the counterparty company)
// AND BY STAGE (negative/lost-stage invoices and negative-stage deals are excluded
// before they reach here — Stage C/D), and this module never looks anything up by
// an arbitrary id — so it can never touch a target outside the resolved set.
//
// NB: the `deal` / `smart-process` target kinds (see `AllocationTargetKind`) are
// resolved by a DIRECT id/field reference, not by amount search — per §2 they are
// UNCONDITIONAL trigger targets and do NOT pass through this amount-based core.
// This module is only for search-found `invoice` / `deal-payment`. Fully unit-tested.

/** The kind of CRM entity a payment can be allocated to (PROCESSING.md §2):
 *  a Smart Invoice, a deal payment, a deal with no payments (trigger only), or a
 *  smart-process element (trigger only). An `order` and a generated document are
 *  NOT targets of their own — they are only ways to FIND one of these. */
export type AllocationTargetKind = 'invoice' | 'deal-payment' | 'deal' | 'smart-process'

/** How each target kind is decided (§2): `amount` targets (invoice / deal-payment) are
 *  matched by exact amount+currency through `resolveAllocation`; `trigger` targets (deal /
 *  smart-process) fire UNCONDITIONALLY by a direct reference and bypass amount matching.
 *  SINGLE SOURCE OF TRUTH, compiler-checked: a new `AllocationTargetKind` won't compile
 *  until it is classified here (TS2741) — so the amount/trigger split can't silently drop
 *  a kind (unlike a bare `Set` literal). Consumed by `summarizeAllocation` here and by
 *  `itemByIdLookup` (amount-gating a non-finite amount). */
export const ALLOCATION_TARGET_ROLE: Record<AllocationTargetKind, 'amount' | 'trigger'> = {
  'invoice': 'amount',
  'deal-payment': 'amount',
  'deal': 'trigger',
  'smart-process': 'trigger'
}

/** True for a target matched by amount+currency (invoice / deal-payment). */
export function isAmountTarget(kind: AllocationTargetKind): boolean {
  return ALLOCATION_TARGET_ROLE[kind] === 'amount'
}

/** True for an unconditional trigger target (deal / smart-process). */
export function isTriggerTarget(kind: AllocationTargetKind): boolean {
  return ALLOCATION_TARGET_ROLE[kind] === 'trigger'
}

/** A candidate entity a payment might close, already scoped to the resolved
 *  companies. `amount`/`currency` are the entity's own; matching is exact. */
export interface AllocationCandidate {
  kind: AllocationTargetKind
  /** Own CRM id: the invoice id, or the deal-payment RECORD id. Used for the
   *  allocation action (`payment.pay` / stage move) and the idempotency fact
   *  key — NOT the deal id (that is `dealId`). Two entities of different `kind`
   *  have independent id spaces, so a numeric collision here is not a match. */
  id: string
  /** Entity amount (positive). Compared to the payment in exact minor units. */
  amount: number
  /** ISO currency code of the entity, e.g. `BYN`. */
  currency: string
  /** Parent deal id — for BOTH kinds: an invoice's `parentId`, or the deal a
   *  payment belongs to. Lets an invoice and a deal payment of the SAME deal be
   *  recognised as ONE target (invoice preferred). Matching is by `dealId`, never
   *  by the record `id`. */
  dealId?: string
  /** The entity's own human number, present when the pool was gathered WITHOUT a
   *  number filter — a deal-payment from `findCompanyDealPayments` carries its
   *  `crm.item.payment` `accountNumber` (e.g. «1/2»). Lets a recognized
   *  `payment-number` be matched against the pool (`filterByAccountNumber`).
   *  Absent for candidates already found BY number (invoices via
   *  `findInvoicesByNumber`, where the query did the matching). */
  accountNumber?: string
}

/** Input to the decision: the payment (from the statement) plus its candidates. */
export interface AllocationInput {
  amount: number
  currency: string
  candidates: readonly AllocationCandidate[]
}

/** The decision. Discriminated by `action`:
 *  - `allocate` — at least one exact target; mark the smallest-id one paid / fire
 *    the trigger. `ambiguous` is true when MORE than one distinct target matched
 *    (owner rule: still auto-allocate to the smallest id, but the caller must post
 *    a heads-up to the chat); `alternatives` are the passed-over targets.
 *  - `none` — no candidates at all for the companies; record a plain дело.
 *  - `manual` — candidates exist but none match the amount exactly (partial /
 *    group payment, or currency mismatch) → «очередь ручного разбора» + notify. */
export type AllocationDecision
  = | { action: 'allocate', target: AllocationCandidate, ambiguous: boolean, alternatives: AllocationCandidate[] }
    | { action: 'none', reason: 'no-candidates' }
    | { action: 'manual', reason: 'no-exact-match', candidates: AllocationCandidate[] }

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
 *  payment exactly (owner's criterion). Partial/group payments — where the amount
 *  differs — are excluded here and surface as `manual` downstream. */
export function isEligible(payment: AllocationInput, c: AllocationCandidate): boolean {
  return sameCurrency(payment.currency, c.currency)
    && toMinorUnits(payment.amount) === toMinorUnits(c.amount)
}

/**
 * Reduce candidates to DISTINCT targets, collapsing only what is provably ONE
 * target seen twice — NOT genuinely different entities:
 *  1. An invoice and a deal payment of the SAME deal (`invoice.dealId ===
 *     payment.dealId`) — two representations of one deal's payment → keep the
 *     INVOICE (preferred per §2), drop the payment.
 *  2. A literal repeat of one entity (same `kind`+`id`) → keep the first.
 * Two DIFFERENT entities of the same amount (e.g. two open invoices of 100 BYN)
 * stay distinct on purpose: the owner's rule is to still auto-allocate (smallest
 * id, in `resolveAllocation`) but flag it `ambiguous` so the chat is notified —
 * silently merging them would hide that ambiguity.
 */
export function collapseSameTarget(candidates: readonly AllocationCandidate[]): AllocationCandidate[] {
  // Deals already covered by an invoice — their deal-payments are the same target.
  const invoiceDealIds = new Set(
    candidates.filter(c => c.kind === 'invoice' && c.dealId).map(c => c.dealId as string)
  )
  const kept: AllocationCandidate[] = []
  for (const c of candidates) {
    // A deal payment whose deal an invoice already covers → same target, skip it.
    if (c.kind === 'deal-payment' && c.dealId && invoiceDealIds.has(c.dealId)) continue
    // A literal repeat of the same entity (same kind + id) → already kept.
    if (kept.some(k => k.kind === c.kind && k.id === c.id)) continue
    kept.push(c)
  }
  return kept
}

/**
 * Narrow a candidate pool to those whose `accountNumber` equals `accountNumber`
 * (exact, trimmed). For resolving a recognized `payment-number` against the
 * company deal-payment pool (`findCompanyDealPayments`), whose candidates were
 * gathered BY COMPANY, not by number. A blank number matches nothing (`[]`) —
 * an empty recognized number must not sweep the whole pool.
 *
 * NB (`order-number`): a payment's `accountNumber` is order-prefixed («<order>/<seq>»,
 * e.g. «1/2»), so an `order-number` matches the PREFIX, not the whole number — see
 * `filterByOrderNumber` below. This helper is for exact numbers (`payment-number`).
 */
/**
 * Strip a recognized identifier's leading LITERAL mask prefix so it compares against a
 * bare-numeric deal-payment field (#242). `recognizeByMatrices` returns the WHOLE matched
 * fragment INCLUDING the mask's literal prefix (`ЗАК-6001`, `BOPC-123/45`), which is correct
 * for an INVOICE (its `accountNumber` literally is `СЧ-1`). But a deal-payment's `accountNumber`
 * is the bare Bitrix `<order>/<seq>` numeric (`6001/1`) and a payment's `id` is a bare integer,
 * so a prefixed value would NEVER match the pool — a portal that binds a prefixed mask to
 * `order-number`/`payment-number`/`payment-id` would silently drop every payment. Drop the
 * leading non-digit run (prefix-shape-based — the recognizer doesn't say which mask matched, but
 * these targets are always digits/`/`). A prefix-less value (`123/45`) is unchanged; an all-
 * literal value collapses to '' → the filters treat it as blank → `[]`. NB: apply ONLY to the
 * pooled deal-payment kinds — NOT to the invoice path, which intentionally keeps the prefix.
 * BOUNDARY (known non-goal): only a LEADING literal run is stripped, so a mask with an INTERIOR
 * non-`/` literal (`dd-dddd` → `12-3456`) is left as-is and simply matches nothing — fail-safe
 * (a miss, never a wrong allocation), since Bitrix payment numbers/ids are `[0-9/]`-only.
 */
export function stripMaskLiteralPrefix(value: string): string {
  return value.replace(/^\D+/u, '')
}

export function filterByAccountNumber(
  candidates: readonly AllocationCandidate[],
  accountNumber: string
): AllocationCandidate[] {
  const n = accountNumber.trim()
  if (!n) return []
  return candidates.filter(c => (c.accountNumber ?? '').trim() === n)
}

/**
 * Narrow a company deal-payment pool to the payments of order `orderNumber`. A
 * payment's `accountNumber` is «<orderNumber>/<seq>» (live-confirmed: order accountNumber
 * «1» → payment «1/1»), where `<seq>` is the final «/»-delimited segment. So the order
 * number is everything BEFORE the LAST «/» — matching on `lastIndexOf('/')` (not the first
 * «/») is correct in BOTH directions:
 *   - a COMPOSITE order number that itself contains «/» matches — a mask `BOPC-ddd/dd` recognizes
 *     «BOPC-123/45», which the caller strips (`stripMaskLiteralPrefix`) to «123/45» before this
 *     compare, matching payment «123/45/1»;
 *   - a SHORTER number does NOT falsely match — order «123» does not own «123/45/1»
 *     (its order part is «123/45», not «123»), and «10» does not match «1/1».
 * Blank number → `[]` (must not sweep the pool); a candidate with no «/» (or an empty order
 * part «/1») is not order-numbered → no match.
 *
 * This matches the order's own NUMBER (accountNumber), NOT its record id — an `order-id`
 * resolves differently: `sale.payment.list` maps the order id → its payment ids, then
 * `filterByPaymentIds` intersects them with this company pool (scope `sale`, #172, done).
 */
export function filterByOrderNumber(
  candidates: readonly AllocationCandidate[],
  orderNumber: string
): AllocationCandidate[] {
  const n = orderNumber.trim()
  if (!n) return []
  return candidates.filter((c) => {
    const acc = (c.accountNumber ?? '').trim()
    const cut = acc.lastIndexOf('/') // order = everything before the final «/<seq>»
    return cut > 0 && acc.slice(0, cut) === n
  })
}

/**
 * Narrow a company deal-payment pool to the payment whose OWN record `id` equals
 * `paymentId` (exact, trimmed). For resolving a recognized `payment-id` against the
 * company deal-payment pool (`findCompanyDealPayments`) — since the pool is already
 * company-scoped, matching the untrusted id inside it is IDOR-safe (a payment of
 * another company is simply not in the pool), and needs no `sale` scope. A blank id
 * matches nothing (`[]`). Distinct from `filterByAccountNumber` (matches the payment's
 * human `accountNumber`, not its record id) and `filterByOrderNumber` (order prefix).
 */
export function filterByPaymentId(
  candidates: readonly AllocationCandidate[],
  paymentId: string
): AllocationCandidate[] {
  const n = paymentId.trim()
  if (!n) return []
  return candidates.filter(c => c.id.trim() === n)
}

/**
 * Narrow a company deal-payment pool to the payments whose OWN record `id` is in
 * `paymentIds` (a set of trimmed record ids). For resolving an `order-id` (#172): the
 * order's payment ids come from `sale.payment.list` (global, not company-scoped), so
 * intersecting them with the already company-scoped pool is what keeps the result
 * IDOR-safe — only a payment of BOTH the named order AND this company survives. An empty
 * `paymentIds` matches nothing (`[]`); blank ids in the set are ignored.
 */
export function filterByPaymentIds(
  candidates: readonly AllocationCandidate[],
  paymentIds: readonly string[]
): AllocationCandidate[] {
  const ids = new Set(paymentIds.map(id => id.trim()).filter(Boolean))
  if (ids.size === 0) return []
  return candidates.filter(c => ids.has(c.id.trim()))
}

/** Compare CRM ids numerically when both are numeric, else lexicographically —
 *  so `id 9` sorts before `id 10` (smallest-id pick must be numeric-aware). */
export function compareIds(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Decide how to allocate one payment against its (company-scoped) candidates.
 * Owner rules (#109): allocate to the SMALLEST-id exact match. `none` when there
 * is nothing to allocate to; `manual` only when candidates exist but none match
 * the amount exactly (partial/group). When more than one distinct target matches,
 * still allocate (smallest id) but set `ambiguous` so the caller notifies the chat.
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
  // Smallest id wins; extra distinct targets make it ambiguous (chat heads-up).
  const ranked = [...collapseSameTarget(eligible)].sort((a, b) => compareIds(a.id, b.id))
  const [target, ...alternatives] = ranked
  return { action: 'allocate', target: target!, ambiguous: alternatives.length > 0, alternatives }
}

/** A payment's allocation outcome for metrics/log (§2): the amount decision, how many
 *  unconditional trigger targets fired, and a single classification label. `allocatable`
 *  = an exact amount match OR ≥1 trigger; `ambiguous` = allocatable with >1 distinct
 *  amount target (auto-allocate smallest id + chat heads-up); `manual` = amount candidates
 *  but no exact match and no trigger (partial/group → «очередь ручного разбора»); `none` =
 *  no candidates at all. `ambiguous` is a stricter case OF allocatable (a caller counting
 *  both bumps allocatable too). */
export interface AllocationSummary {
  decision: AllocationDecision
  triggerTargets: number
  outcome: 'allocatable' | 'ambiguous' | 'manual' | 'none'
}

/**
 * Classify one payment's candidates (§2) WITHOUT any I/O — partition amount vs trigger
 * targets from the (already company+stage-filtered) candidate list, run `resolveAllocation`
 * over the amount ones, and fold the amount decision + trigger presence into one `outcome`.
 * Pure and directly unit-testable; the crm-sync handler calls this and bumps its counters,
 * and the write slice (#184) will reuse it instead of re-deriving the split.
 */
export function summarizeAllocation(payment: AllocationInput): AllocationSummary {
  const amountCandidates = payment.candidates.filter(c => isAmountTarget(c.kind))
  // Distinct trigger targets by kind+id — two intents can resolve to the SAME deal/
  // smart-process (e.g. deal-id + a document bridging to it); count it once, not twice.
  // (Amount targets are deduped by `collapseSameTarget` inside `resolveAllocation`.)
  const triggerTargets = new Set(
    payment.candidates.filter(c => isTriggerTarget(c.kind)).map(c => `${c.kind}:${c.id}`)
  ).size
  const decision = resolveAllocation({ amount: payment.amount, currency: payment.currency, candidates: amountCandidates })
  let outcome: AllocationSummary['outcome']
  if (decision.action === 'allocate') {
    outcome = decision.ambiguous ? 'ambiguous' : 'allocatable'
  } else if (triggerTargets > 0) {
    // No exact amount match, but an unconditional trigger fires → still allocatable.
    outcome = 'allocatable'
  } else {
    outcome = decision.action === 'manual' ? 'manual' : 'none'
  }
  return { decision, triggerTargets, outcome }
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
