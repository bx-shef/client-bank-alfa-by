// Read whether a decided allocate TARGET is already in its paid/settled state in B24 — the
// Фаза A idempotency source-of-truth for the AMOUNT mutation (#109, PROCESSING.md §1/§2).
//
// Replaces the `allocation_fact` pre-check (`hasAllocationFact`) for the amount mutation with
// a direct read of B24 state. This is not just philosophy (idempotency in B24, not our DB) —
// it is MORE correct: the fact is recorded AFTER a confirmed pay, so a crash between the pay
// and the fact write leaves NO fact, and the old `hasAllocationFact` pre-check would then
// RE-PAY on redelivery. `paid='Y'` / the paid invoice stage are authoritative, so a redelivery
// reads the true state and skips.
//
// Pure over an injected `RestCall` (DI, unit-testable). Only AMOUNT targets have a readable
// applied-state; trigger targets (deal / smart-process) return false — a trigger fire is a
// stateless signal with nothing to read back, so they dedup on the dist-СП marker
// (`hasTriggerFact`, §9.3 #6). A read error PROPAGATES (the caller fails the job → clean retry); the reader never
// throws on its own — it returns false whenever it cannot PROVE the target is applied, so the
// mutation runs (fail-safe toward attempting the pay, whose own confirm-or-throw guards double-pay).

import type { RestCall } from './companyLookup'
import type { AllocationCandidate } from '../../app/utils/allocation'
import { paymentListParams, extractPayments } from './paymentLookup'

/** entityTypeId of the smart-invoice (same as invoiceLookup / allocationMutation). */
const INVOICE_ENTITY_TYPE_ID = 31

export interface AllocationAppliedOpts {
  /** The invoice "paid" stage from settings — needed to judge an invoice as settled.
   *  Empty/absent ⇒ we never move an invoice, so it can never be "already applied by us". */
  invoicePaidStageId?: string
}

/** Is the deal-payment already paid (`paid='Y'`)? Reads `crm.item.payment.list` for the deal
 *  and finds the payment by its record id. Needs `target.dealId`; without it (or when the
 *  payment isn't in the list) returns false — we can't prove it's applied, so we don't skip. */
async function isDealPaymentPaid(target: AllocationCandidate, call: RestCall): Promise<boolean> {
  const dealId = Number(String(target.dealId ?? '').trim())
  if (!Number.isInteger(dealId) || dealId <= 0) return false
  const resp = await call('crm.item.payment.list', paymentListParams(dealId)) as Record<string, unknown>
  for (const p of extractPayments(resp)) {
    if (String(p.id ?? '') === target.id) {
      return String(p.paid ?? '').trim().toUpperCase() === 'Y'
    }
  }
  return false
}

/** Is the invoice already on its configured paid stage? Reads the invoice by id and compares
 *  `stageId` to `invoicePaidStageId`. No configured stage ⇒ false (we never move it). */
async function isInvoiceSettled(target: AllocationCandidate, call: RestCall, paidStageId: string): Promise<boolean> {
  const stage = paidStageId.trim()
  if (!stage) return false
  const id = Number(target.id)
  if (!Number.isInteger(id) || id <= 0) return false
  const resp = await call('crm.item.list', {
    entityTypeId: INVOICE_ENTITY_TYPE_ID,
    filter: { id },
    select: ['id', 'stageId']
  }) as { result?: { items?: Array<Record<string, unknown>> } } | null
  const items = resp?.result?.items ?? []
  const invoice = items.find(it => String(it.id ?? '') === target.id)
  return invoice ? String(invoice.stageId ?? '') === stage : false
}

/**
 * Read whether a decided allocate TARGET is already applied (paid/settled) in B24 — the
 * Фаза A idempotency pre-check for the amount mutation, replacing `hasAllocationFact`:
 *   - `deal-payment` → the payment's `paid='Y'`;
 *   - `invoice`     → the item is already on the configured `invoicePaidStageId`;
 *   - anything else (trigger targets) → false (no readable applied-state).
 * Returns false whenever it can't prove the target is applied, so the mutation runs.
 */
export async function readAllocationApplied(
  target: AllocationCandidate,
  call: RestCall,
  opts: AllocationAppliedOpts = {}
): Promise<boolean> {
  if (target.kind === 'deal-payment') return isDealPaymentPaid(target, call)
  if (target.kind === 'invoice') return isInvoiceSettled(target, call, opts.invoicePaidStageId ?? '')
  return false
}
