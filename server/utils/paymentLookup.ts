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
// SCOPE — this resolves the deal-payment WHEN THE DEAL IS ALREADY KNOWN (e.g. a
// `deal-id` identifier, or iterating a company's deals). It does NOT locate a
// payment/order globally by its own number without the parent deal:
// `crm.item.payment.list` REQUIRES `entityId`, and a portal-wide lookup by order/
// payment number needs `sale.*` (scope `sale`, which the app does not hold yet) —
// tracked separately. See PROCESSING.md §4 (`order-number`/`payment-number`).

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
 *  both `entityId` and `entityTypeId`; there is no cross-entity variant in `crm`. */
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
 * A blank / non-numeric `dealId` yields `[]` without a REST call.
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
