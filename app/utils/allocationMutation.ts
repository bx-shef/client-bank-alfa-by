import type { AllocationCandidate } from '~/utils/allocation'

// Pure builder for the portal MUTATION that marks a decided allocation target as
// paid/distributed (§2 mutation slice, #109). No I/O — it only describes the REST
// request; the transport (`server/utils/allocationMutationWrite.ts`) performs it.
//
// Supported v1 mutations (both live-confirmed, scope `crm`):
//   - `deal-payment` → `crm.item.payment.pay` (mark the deal payment paid).
//   - `invoice` → `crm.item.update` stageId — ONLY when the operator configured a
//     paid-stage id (`opts.invoicePaidStageId`); with no configured stage we don't
//     touch the invoice (returns `null`), per PROCESSING.md §2 «указана → перевести;
//     не указана → не трогаем».
// The remaining kinds have no v1 mutation here:
//   - `deal` / `smart-process` — unconditional TRIGGER targets, fired by the trigger
//     slice, not the amount-based pay path.
// An unsupported target (or an invoice with no configured stage) returns `null`, so
// the caller records the fact but performs no portal write.

/** Smart-invoice object type id (`crm.item.*` entityTypeId). Mirrors the server
 *  `invoiceLookup.SMART_INVOICE_ENTITY_TYPE_ID`; kept here so this app-side pure
 *  builder needs no server import (asserted equal to 31 in the tests). */
export const SMART_INVOICE_ENTITY_TYPE_ID = 31

/** How the transport verifies the portal response for a mutation:
 *  `boolean` → `{result:true}` (payment.pay); `object` → `{result:{item:…}}` (item.update). */
export type MutationResultKind = 'boolean' | 'object'

/** Options that parameterize a mutation from portal settings (§2). */
export interface AllocationMutationOptions {
  /** Configured target stage for a paid invoice (`crm.item.update` stageId). Empty/
   *  absent ⇒ invoice stage is NOT changed (no mutation emitted for an invoice). */
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
  /** How the transport reads success from the portal response. */
  resultKind: MutationResultKind
}

/**
 * Build the portal mutation for a decided allocation TARGET, or `null` when the
 * target kind has no supported v1 mutation (or an invoice with no configured stage).
 * Ids are validated as positive integers so a malformed value never becomes a call.
 */
export function buildAllocationMutation(
  target: Pick<AllocationCandidate, 'kind' | 'id'>,
  opts: AllocationMutationOptions = {}
): AllocationMutation | null {
  // Strict POSITIVE-INTEGER id. CRM record ids are positive ints (`String(id)`), so
  // reject anything that isn't digits-only and > 0 — blank, `abc`, ` 5 `, `4.5`, `0`,
  // `Infinity` — rather than let `Number()`'s loose coercion emit a malformed call.
  const isValidId = /^\d+$/.test(target.id) && Number(target.id) > 0

  if (target.kind === 'deal-payment') {
    if (!isValidId) return null
    return { method: 'crm.item.payment.pay', params: { id: Number(target.id) }, kind: 'deal-payment', id: target.id, resultKind: 'boolean' }
  }

  if (target.kind === 'invoice') {
    // Only transition the stage when the operator configured a paid-stage id; else
    // leave the invoice untouched (fact still recorded by the caller).
    const stageId = (opts.invoicePaidStageId ?? '').trim()
    if (!isValidId || !stageId) return null
    return {
      method: 'crm.item.update',
      params: { entityTypeId: SMART_INVOICE_ENTITY_TYPE_ID, id: Number(target.id), fields: { stageId } },
      kind: 'invoice',
      id: target.id,
      resultKind: 'object'
    }
  }

  // deal / smart-process — trigger slice, no amount-path mutation.
  return null
}
