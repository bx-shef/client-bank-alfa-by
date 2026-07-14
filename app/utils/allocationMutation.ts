import type { AllocationCandidate } from '~/utils/allocation'

// Pure builder for the portal MUTATION that marks a decided allocation target as
// paid/distributed (§2 mutation slice, #109). No I/O — it only describes the REST
// request; the transport (`server/utils/allocationMutationWrite.ts`) performs it.
//
// v1 supports ONLY `deal-payment` → `crm.item.payment.pay` (live-confirmed, scope
// `crm`). The other target kinds have no v1 mutation here:
//   - `invoice` — stage change needs a portal-configured target stage (карта
//     сопоставления, §4); until that config slice lands, no mutation is emitted.
//   - `deal` / `smart-process` — unconditional TRIGGER targets, fired by the
//     trigger slice, not the amount-based pay path.
// An unsupported target returns `null`, so the caller records the fact but performs
// no portal write.

/** entityTypeId of the smart-invoice (live-confirmed; same as `invoiceLookup`). */
const INVOICE_ENTITY_TYPE_ID = 31

/** Config that drives target-specific mutations (from portal settings `allocation`). */
export interface AllocationMutationOpts {
  /** Target stage id for an INVOICE target; empty/absent ⇒ no invoice mutation. */
  invoicePaidStageId?: string
}

/** A described portal mutation request (method + params) for one allocate target. */
export interface AllocationMutation {
  /** REST method to call (e.g. `crm.item.payment.pay`). */
  method: string
  /** Params for the method. */
  params: Record<string, unknown>
  /** The target kind this mutation acts on (for logging/counters). */
  kind: AllocationCandidate['kind']
  /** The target id being mutated. */
  id: string
}

/**
 * Build the portal mutation for a decided allocation TARGET, or `null` when the
 * target kind has no supported v1 mutation. `crm.item.payment.pay` takes the
 * payment id as a number (`sale_order_payment.id`); a non-numeric/blank id yields
 * `null` (never emit a malformed pay call).
 */
export function buildAllocationMutation(
  target: Pick<AllocationCandidate, 'kind' | 'id'>,
  opts: AllocationMutationOpts = {}
): AllocationMutation | null {
  if (target.kind === 'deal-payment') {
    // Strict POSITIVE-INTEGER id. A payment id is always a positive CRM record id
    // (`String(sale_order_payment.id)`), so reject anything that isn't digits-only and
    // > 0 — blank, `abc`, ` 5 `, `4.5`, `0`, `Infinity` — rather than let `Number()`'s
    // loose coercion emit a malformed / zero pay call («never emit a malformed pay call»).
    if (!/^\d+$/.test(target.id) || Number(target.id) <= 0) return null
    return { method: 'crm.item.payment.pay', params: { id: Number(target.id) }, kind: 'deal-payment', id: target.id }
  }
  if (target.kind === 'invoice') {
    // Move the invoice to its configured "paid" stage (карта настроек, §2). No stage
    // configured ⇒ do NOT touch the invoice («не указана → не трогаем»). Same strict
    // positive-integer id guard — never emit a malformed update.
    const stageId = (opts.invoicePaidStageId ?? '').trim()
    if (!stageId) return null
    if (!/^\d+$/.test(target.id) || Number(target.id) <= 0) return null
    return {
      method: 'crm.item.update',
      params: { entityTypeId: INVOICE_ENTITY_TYPE_ID, id: Number(target.id), fields: { stageId } },
      kind: 'invoice',
      id: target.id
    }
  }
  // deal / smart-process — unconditional TRIGGER targets (trigger slice), no v1 pay mutation.
  return null
}
