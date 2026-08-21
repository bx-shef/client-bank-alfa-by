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
// must NEVER fail the batch. It returns a TriggerOutcome telling the handler what to do:
//   'fired'  — confirmed `{result:true}` → record the durable fact, count it.
//   'skip'   — never fire / can't be helped (demo account, or a malformed/unsupported CODE/target) →
//              do nothing, no retry.
//   'retry'  — a MISS a durable retry could heal (transient token/network error, OR a `triggerCode`
//              set but not yet registered) → the handler enqueues the durable retry (#79) so the
//              signal self-heals. Any thrown transport error also maps to 'retry'.
// See docs/PROCESSING.md §2.

import type { StatementItem } from '../../app/types/statement'
import type { AllocationCandidate } from '../../app/utils/allocation'
import type { AllocationMutationResult } from './allocationMutationWrite'
import type { RestCall } from './companyLookup'
import { useServerLogger } from './serverLogger'

const log = useServerLogger('trigger')

/** What the handler should do after a synchronous trigger attempt (#79). */
export type TriggerOutcome = 'fired' | 'skip' | 'retry'

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
 * Build the `applyTrigger` dep. Returns a TriggerOutcome (see header). The full `target` is
 * forwarded UNCHANGED to the transport (so `entityTypeId` survives for a smart-process target) —
 * this is the invariant the wire test pins. 'skip' for a demo account or a malformed/unsupported
 * CODE/target; 'retry' for a missed fire a durable retry could heal (transient, or not-yet-registered).
 */
export function makeApplyTrigger(deps: ApplyTriggerDeps) {
  return async function applyTrigger(
    item: StatementItem,
    target: AllocationCandidate,
    memberId: string,
    code: string
  ): Promise<TriggerOutcome> {
    try {
      // Inside the try so the best-effort contract holds even if a dep throws
      // (isDemoAccount included) — a trigger failure must NEVER fail the batch.
      if (deps.isDemoAccount(item.account)) return 'skip'
      const call = await deps.resolvePortalCall(memberId)
      if (!call) return 'retry' // token pending (refresh race / uninstall) — a durable retry is bounded
      const res = await deps.executeTriggerViaRest(target, call, { triggerCode: code })
      if (res.applied) return 'fired'
      // A malformed CODE mask / unsupported target returns `skipped:'unsupported'` WITHOUT a REST call
      // — a retry can't help. Any OTHER non-fire is a transient/not-registered miss → durable retry.
      return res.skipped === 'unsupported' ? 'skip' : 'retry'
    } catch (e) {
      // Thrown transport error (network, or «trigger is not registered») → durable retry self-heals.
      log.warning(`portal ${memberId}, ${target.kind}#${target.id}: not fired (will retry) — ${(e as Error)?.message}`)
      return 'retry'
    }
  }
}
