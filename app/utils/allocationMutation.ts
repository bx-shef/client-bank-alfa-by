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

/** crm.enum.ownertype id of a DEAL — the OWNER_TYPE_ID for a deal trigger. */
const DEAL_OWNER_TYPE_ID = 2

/** Valid trigger CODE mask per the crm.automation.trigger API: lowercase alnum + `.` `-` `_`.
 *  A configured code that doesn't match is treated as "no trigger" (fail-safe — never send a
 *  malformed CODE the portal would reject). */
const TRIGGER_CODE_RE = /^[a-z0-9.\-_]+$/

/** Config that drives target-specific mutations (from portal settings `allocation`). */
export interface AllocationMutationOpts {
  /** Target stage id for an INVOICE target; empty/absent ⇒ no invoice mutation. */
  invoicePaidStageId?: string
}

/** Config that drives the automation TRIGGER for trigger targets (deal / smart-process). */
export interface TriggerExecutionOpts {
  /** Registered trigger CODE (from portal settings, `crm.automation.trigger.add` on install).
   *  Empty/absent/malformed ⇒ no trigger is emitted (fail-safe). */
  triggerCode?: string
}

/** A described `crm.automation.trigger.execute` call for one decided trigger target. */
export interface TriggerExecution {
  method: 'crm.automation.trigger.execute'
  /** CODE + OWNER_TYPE_ID + OWNER_ID — the ONLY params the method accepts (live-doc-confirmed;
   *  amount/currency are NOT passed — the trigger is just a "money arrived" signal, the client's
   *  automation rule decides the rest). */
  params: { CODE: string, OWNER_TYPE_ID: number, OWNER_ID: number }
  /** The trigger target kind (deal / smart-process), for logging/counters. */
  kind: AllocationCandidate['kind']
  /** The owner id being triggered. */
  id: string
}

/**
 * Build the `crm.automation.trigger.execute` call for a decided TRIGGER target (deal /
 * smart-process), or `null` when it can't/shouldn't fire:
 *   - no / malformed `triggerCode` (must match `[a-z0-9.\-_]`) ⇒ `null` («не настроен → не трогаем»);
 *   - non-positive-integer owner id ⇒ `null` (never send a malformed OWNER_ID);
 *   - a `smart-process` target without a positive-integer `entityTypeId` ⇒ `null` (its OWNER_TYPE_ID
 *     is the portal-specific dynamic type id — we can't guess it);
 *   - an amount target (`invoice` / `deal-payment`) ⇒ `null` (those go through `buildAllocationMutation`).
 * NB: this only DESCRIBES the call — execution (which needs OAuth application context, #79) is the
 * transport's job and is still gated behind install-time CODE registration + live-verify.
 */
export function buildTriggerExecution(
  target: Pick<AllocationCandidate, 'kind' | 'id'> & { entityTypeId?: number },
  opts: TriggerExecutionOpts = {}
): TriggerExecution | null {
  const code = (opts.triggerCode ?? '').trim()
  if (!code || !TRIGGER_CODE_RE.test(code)) return null
  if (!/^\d+$/.test(target.id) || Number(target.id) <= 0) return null
  let ownerTypeId: number
  if (target.kind === 'deal') {
    ownerTypeId = DEAL_OWNER_TYPE_ID
  } else if (target.kind === 'smart-process') {
    const etid = target.entityTypeId
    if (typeof etid !== 'number' || !Number.isInteger(etid) || etid <= 0) return null
    ownerTypeId = etid
  } else {
    return null // invoice / deal-payment are amount targets, not triggers
  }
  return {
    method: 'crm.automation.trigger.execute',
    params: { CODE: code, OWNER_TYPE_ID: ownerTypeId, OWNER_ID: Number(target.id) },
    kind: target.kind,
    id: target.id
  }
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
