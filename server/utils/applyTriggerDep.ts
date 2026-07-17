// The crm-sync `applyTrigger` dependency (#79), extracted from worker.ts as a pure
// factory so the handler→transport JOIN is unit-testable without the live SDK/DB.
//
// This is the ONLY code that connects a resolved trigger candidate (from the handler)
// to the transport (`executeTriggerViaRest`). If it dropped a candidate field — e.g.
// passed `{kind, id}` instead of the full `target` — a smart-process trigger would
// lose its `entityTypeId` and silently never fire, yet every handler/transport test
// would still pass (they use hand-built candidates). So the wire itself needs a test.
//
// BEST-EFFORT: a trigger SIGNALS «деньги пришли», it does not move money, so a failure
// must NEVER fail the batch. Demo accounts are gated; no portal token → skip; any thrown
// transport error is swallowed+logged and returns false (the handler records the
// write-once fact ONLY on a confirmed fire). See docs/PROCESSING.md §2.

import type { StatementItem } from '../../app/types/statement'
import type { AllocationCandidate } from '../../app/utils/allocation'
import type { AllocationMutationResult } from './allocationMutationWrite'
import type { RestCall } from './companyLookup'

export interface ApplyTriggerDeps {
  /** True for a synthetic demo account — never fire a real portal trigger for it. */
  isDemoAccount: (account: string) => boolean
  /** Resolve the per-portal RestCall (OAuth app-context — required by the method);
   *  `null` when the portal has no token (uninstalled mid-batch) → skip. */
  resolvePortalCall: (memberId: string) => Promise<RestCall | null>
  /** Transport that builds + sends `crm.automation.trigger.execute`. */
  executeTriggerViaRest: (
    target: Pick<AllocationCandidate, 'kind' | 'id'> & { entityTypeId?: number },
    call: RestCall,
    opts: { triggerCode?: string }
  ) => Promise<AllocationMutationResult>
}

/**
 * Build the `applyTrigger` dep. Returns whether the trigger actually FIRED. The full
 * `target` is forwarded UNCHANGED to the transport (so `entityTypeId` survives for a
 * smart-process target) — this is the invariant the wire test pins.
 */
export function makeApplyTrigger(deps: ApplyTriggerDeps) {
  return async function applyTrigger(
    item: StatementItem,
    target: AllocationCandidate,
    memberId: string,
    code: string
  ): Promise<boolean> {
    if (deps.isDemoAccount(item.account)) return false
    try {
      const call = await deps.resolvePortalCall(memberId)
      if (!call) return false
      const res = await deps.executeTriggerViaRest(target, call, { triggerCode: code })
      return res.applied
    } catch (e) {
      console.warn(`[trigger] portal ${memberId}, ${target.kind}#${target.id}: not fired — ${(e as Error)?.message}`)
      return false
    }
  }
}
