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
export function buildAllocationMutation(target: Pick<AllocationCandidate, 'kind' | 'id'>): AllocationMutation | null {
  if (target.kind === 'deal-payment') {
    const num = Number(target.id)
    if (!target.id || !Number.isFinite(num)) return null
    return { method: 'crm.item.payment.pay', params: { id: num }, kind: 'deal-payment', id: target.id }
  }
  // invoice (needs configured stage) / deal / smart-process (trigger slice) — no v1 mutation.
  return null
}
