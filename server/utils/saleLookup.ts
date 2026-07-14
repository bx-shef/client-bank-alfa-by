// Order → its payment record ids, via the `sale` scope (#172, `order-id`). Pure over
// an injected `RestCall` — unit-testable without the network.
//
// WHY (order-id resolution): the recognized value is an ORDER's own record id. Unlike
// `order-number` (which appears as the «<order>/<seq>» prefix of a payment's
// `accountNumber` and is matched inside the company pool), an order's id is NOT carried
// by `crm.item.payment.list` (live-confirmed: no `orderId` field even with an explicit
// `select`). So we map the order id → its payment ids with `sale.payment.list`
// (`filter: { orderId }`), which DOES expose `orderId`/`id` (live-confirmed).
//
// SCOPE & IDOR: `sale.payment.list` is GLOBAL — a `sale.order` carries no company link
// (`companyId` is null for CRM orders), so the order id from a payer-controlled purpose
// can't be company-scoped here. The CALLER MUST intersect the returned payment ids with
// the payer company's OWN deal-payment pool (`findCompanyDealPayments`) before acting —
// only a payment that is BOTH of the named order AND in the company pool is a valid
// candidate. This module returns bare ids on purpose; it performs no allocation itself.
// Requires the `sale` scope (see `app/config/b24.ts` `B24_REQUIRED_SCOPES`).

import type { RestCall } from './companyLookup'

/** `sale.payment.list` params — payments of ONE order by its id. Only the `id` is
 *  read back (we intersect ids with the company pool); `orderId` is echoed for the guard. */
export function orderPaymentsParams(orderId: string): Record<string, unknown> {
  return { filter: { orderId }, select: ['id', 'orderId'] }
}

interface RawSalePayment {
  id?: unknown
  orderId?: unknown
}

/** Pull the `result.payments` array out of a `sale.payment.list` response (tolerant). */
export function extractSalePayments(resp: Record<string, unknown>): RawSalePayment[] {
  const payments = (resp?.result as Record<string, unknown> | undefined)?.payments
  return Array.isArray(payments) ? (payments as RawSalePayment[]) : []
}

/**
 * Return the payment RECORD ids of order `orderId` (via `sale.payment.list`). A blank
 * id yields `[]` WITHOUT a REST call (an empty filter would list every payment). Each
 * returned id is also re-checked to belong to the requested order (`orderId` echo) —
 * a defensive guard in case the portal ignores the filter. Ids are strings (to compare
 * with the company pool's `AllocationCandidate.id`). A transport error propagates.
 *
 * IDOR: the caller MUST intersect these ids with the payer company's deal-payment pool
 * (this list is NOT company-scoped — see the module header).
 */
export async function findOrderPaymentIds(orderId: string, call: RestCall): Promise<string[]> {
  const id = orderId.trim()
  if (!id) return []
  const resp = await call('sale.payment.list', orderPaymentsParams(id))
  const out: string[] = []
  for (const p of extractSalePayments(resp)) {
    // Guard: keep only rows the portal actually scoped to this order (filter echo).
    if (p.orderId === undefined || p.orderId === null || String(p.orderId).trim() !== id) continue
    const pid = p.id === undefined || p.id === null ? '' : String(p.id).trim()
    if (pid) out.push(pid)
  }
  return out
}
