// Transport for the allocation MUTATION (§2 mutation slice, #109): perform the
// portal write that marks a decided allocate target paid. Thin — the request is
// built by the pure `buildAllocationMutation`; here we only call it and read the
// boolean result. A REST error PROPAGATES (throw) so the job retries cleanly.

import type { RestCall } from './companyLookup'
import type { AllocationCandidate } from '../../app/utils/allocation'
import {
  buildAllocationMutation,
  buildTriggerExecution,
  type AllocationMutationOpts,
  type TriggerExecutionOpts
} from '../../app/utils/allocationMutation'

/** Outcome of an allocation mutation attempt. `applied` is true only when the
 *  portal confirmed the write (`{result:true}`). `skipped` is set when the target
 *  kind has no v1 mutation (nothing was called). */
export interface AllocationMutationResult {
  applied: boolean
  method?: string
  kind?: string
  id?: string
  skipped?: 'unsupported'
}

/**
 * Mark a decided allocate target paid in the portal. For a `deal-payment` this is
 * `crm.item.payment.pay { id }` → `{result:true}`. Unsupported target kinds (no v1
 * mutation) return `{applied:false, skipped:'unsupported'}` WITHOUT any REST call.
 * A REST/transport error is thrown (the caller fails the job → clean retry).
 */
export async function payAllocationViaRest(
  target: Pick<AllocationCandidate, 'kind' | 'id'>,
  call: RestCall,
  opts: AllocationMutationOpts = {}
): Promise<AllocationMutationResult> {
  const mutation = buildAllocationMutation(target, opts)
  if (!mutation) return { applied: false, skipped: 'unsupported' }
  const resp = await call(mutation.method, mutation.params) as { result?: unknown } | null
  // `callRest` returns the FULL B24 envelope, and success shape differs per method:
  //   `crm.item.payment.pay` → `{result: true}`
  //   `crm.item.update`      → `{result: {item: {…}}}`   (live-confirmed on portal)
  // Treat a `true` result OR a `result.item` object as an applied write.
  const result = resp?.result
  const applied = result === true
    || (typeof result === 'object' && result !== null && 'item' in result)
  return { applied, method: mutation.method, kind: mutation.kind, id: mutation.id }
}

/**
 * Fire the automation TRIGGER for a decided trigger target (deal / smart-process) via
 * `crm.automation.trigger.execute` → `{result:true}`. Built by the pure `buildTriggerExecution`;
 * when it yields `null` (no/invalid CODE, bad id, smart-process без entityTypeId, or an amount
 * target) NOTHING is called and `{applied:false, skipped:'unsupported'}` is returned. A REST error
 * PROPAGATES (the job fails → clean retry).
 *
 * BLOCKER (#79): the method needs OAuth **application context** (a webhook token gets
 * «Application context required») and a CODE that the app REGISTERED at install
 * (`crm.automation.trigger.add`). So this transport is not wired into the crm-sync hot path yet —
 * it is verified by unit tests here and awaits the install-registration + OAuth-portal live-verify.
 */
export async function executeTriggerViaRest(
  target: Pick<AllocationCandidate, 'kind' | 'id'> & { entityTypeId?: number },
  call: RestCall,
  opts: TriggerExecutionOpts = {}
): Promise<AllocationMutationResult> {
  const trigger = buildTriggerExecution(target, opts)
  if (!trigger) return { applied: false, skipped: 'unsupported' }
  const resp = await call(trigger.method, trigger.params) as { result?: unknown } | null
  // `crm.automation.trigger.execute` → `{result:true}` on a successful fire (live-doc-confirmed).
  return { applied: resp?.result === true, method: trigger.method, kind: trigger.kind, id: trigger.id }
}
