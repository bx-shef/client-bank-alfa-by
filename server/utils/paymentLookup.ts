// Deal-payment candidates for an incoming bank payment (#109, PROCESSING.md §2).
// Given a KNOWN deal, list its payments (`crm.item.payment.list`) and map the
// allocatable ones to `AllocationCandidate` (kind `deal-payment`). Pure over an
// injected `RestCall` — unit-testable without the network.
//
// Field names confirmed LIVE against a real portal (seeded deal with a real
// crm.item.payment): the response is an array DIRECTLY in `result` (not
// `result.items`), each element `{ id, accountNumber, paid: 'Y'|'N', sum,
// currency, paySystemId, … }`. `id` is the payment RECORD id (→ `payment.pay`),
// `sum`/`currency` are the payment amount, `paid` its settlement status.
//
// SCOPE & IDOR — this resolves a deal-payment WHEN THE DEAL IS ALREADY KNOWN AND
// COMPANY-SCOPED. `crm.item.payment.list` filters ONLY by `entityId` (the deal) —
// it has no `companyId` field, so unlike `invoiceLookup`/`itemByIdLookup` the
// company scope is NOT enforced in the query here. The CALLER MUST pass a `dealId`
// it already validated belongs to the payer's company (a deal resolved via
// `itemByIdLookup.findCandidateById` with `companyId`, or a company-scoped deal
// scan). Passing a payer-controlled `dealId` unchecked would be an IDOR.
//
// It does NOT locate a payment/order globally by its own id OR number without the
// parent deal: `crm.item.payment.list` REQUIRES `entityId`, and a portal-wide
// lookup — ALL of `order-id`/`order-number`/`payment-id`/`payment-number` — needs
// `sale.*` (scope `sale`, which the app does not hold yet) — tracked in #172.
//
// NB: in `identifierDispatch` a `deal-id` routes to the `deal` trigger target, not
// to `deal-payment`. The crm-sync wiring slice branches: a resolved deal WITH a
// matching unpaid payment → `deal-payment` (this module); otherwise a bare `deal`
// trigger. So this module runs AFTER the deal is resolved, never with a raw
// identifier value from the purpose.

import type { AllocationCandidate } from '../../app/utils/allocation'
import type { RestCall } from './companyLookup'

/** CRM entityTypeId of a Deal (сделка) — the owner of its payments. */
export const DEAL_ENTITY_TYPE_ID = 2

export interface DealPaymentOptions {
  /** Include payments already marked paid (`paid: 'Y'`). Default `false` — a
   *  settled payment is not an allocation target (nothing left to `payment.pay`). */
  includePaid?: boolean
}

/** `crm.item.payment.list` params — payments of ONE deal. The method requires
 *  both `entityId` and `entityTypeId`; there is no cross-entity variant in `crm`.
 *  No `select`: the method does not document one — it returns the full short
 *  payment shape (`id`/`accountNumber`/`paid`/`sum`/`currency`/…) unconditionally. */
export function paymentListParams(dealId: number, entityTypeId: number = DEAL_ENTITY_TYPE_ID): Record<string, unknown> {
  return { entityId: dealId, entityTypeId }
}

interface RawPayment {
  id?: unknown
  paid?: unknown
  sum?: unknown
  currency?: unknown
}

/** Pull the payments array out of a `crm.item.payment.list` response. The list
 *  sits DIRECTLY in `result` (an array), unlike `crm.item.list`'s `result.items`. */
export function extractPayments(resp: Record<string, unknown>): RawPayment[] {
  const result = resp?.result
  return Array.isArray(result) ? (result as RawPayment[]) : []
}

/**
 * Find deal-payment allocation candidates for `dealId`, dropping payments that
 * are already settled (`paid: 'Y'`) unless `opts.includePaid`. Returns
 * `AllocationCandidate[]` (kind `deal-payment`, `amount` = `sum`, `currency`,
 * `id` = payment record id, `dealId` = the parent deal). Rows with a non-finite
 * `sum` are skipped (can't be matched by amount). A transport error from `call`
 * propagates; "no payments" is an empty array, never a throw.
 *
 * PRECONDITION: `dealId` MUST already be scoped to the payer's company (see the
 * file header — no company filter is possible in `crm.item.payment.list`).
 *
 * A blank / non-numeric / non-positive `dealId` yields `[]` without a REST call.
 * No pagination (`start`): a single deal's payments are expected to be a handful
 * of rows; if that ever grows past one page, page here before wiring into crm-sync.
 */
export async function findDealPayments(
  dealId: string,
  opts: DealPaymentOptions,
  call: RestCall
): Promise<AllocationCandidate[]> {
  const id = String(dealId).trim()
  const numericId = Number(id)
  if (!id || !Number.isInteger(numericId) || numericId <= 0) return []

  const resp = await call('crm.item.payment.list', paymentListParams(numericId))
  const out: AllocationCandidate[] = []
  for (const p of extractPayments(resp)) {
    const paid = String(p.paid ?? '').trim().toUpperCase() === 'Y'
    if (paid && !opts.includePaid) continue
    const amount = Number(p.sum)
    if (!Number.isFinite(amount)) continue
    const paymentId = p.id === undefined || p.id === null ? '' : String(p.id)
    if (!paymentId) continue
    out.push({ kind: 'deal-payment', id: paymentId, amount, currency: String(p.currency ?? ''), dealId: id })
  }
  return out
}
