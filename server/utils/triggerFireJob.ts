import type { TriggerFireJob } from '../queue/topology'
import type { AllocationCandidate } from '../../app/utils/allocation'
import type { AllocationMutationResult } from './allocationMutationWrite'
import type { RestCall } from './companyLookup'

// Pure worker for the durable payment-trigger retry (#79). crm-sync fired the trigger once and missed
// (transient error, or a `triggerCode` not yet registered); this re-fires with backoff so the «деньги
// пришли» signal self-heals. A trigger only SIGNALS (moves no money), so a redelivered double-fire is a
// benign double-signal. DI over the side effects (portal call + transport) → unit-testable without SDK.
//
// Fire-only by design: no durable SP-ledger fact / metric is written here (the audit row is written on
// the SYNCHRONOUS fire; a retried fire is the exceptional path). The retry job's idempotent jobId dedups
// re-enqueues; at-least-once delivery is acceptable for an idempotent signal.

export interface TriggerFireJobDeps {
  /** Resolve the per-portal RestCall (OAuth app-context — required by the method); `null` when the
   *  portal has no token → throw (pending; a bounded retry, exhausts if the portal is gone). */
  resolvePortalCall: (memberId: string) => Promise<RestCall | null>
  /** Transport that builds + sends `crm.automation.trigger.execute`. */
  executeTriggerViaRest: (
    target: Pick<AllocationCandidate, 'kind' | 'id'> & { entityTypeId?: number },
    call: RestCall,
    opts: { triggerCode?: string }
  ) => Promise<AllocationMutationResult>
}

/**
 * Re-fire a payment trigger.
 * - fired (`{result:true}`) → ack (return).
 * - `skipped:'unsupported'` (malformed CODE/target — no REST call) → PERMANENT, ack + log (a retry
 *   can't help; drop).
 * - not confirmed, or a thrown transport error (network / «trigger is not registered»), or no portal
 *   token → THROW so BullMQ retries with backoff (the not-registered case self-heals once registered).
 */
export async function handleTriggerFireJob(job: TriggerFireJob, deps: TriggerFireJobDeps): Promise<void> {
  const call = await deps.resolvePortalCall(job.memberId)
  if (!call) throw new Error(`trigger retry: no portal token for ${job.memberId} — retry (pending)`)
  const target = { kind: job.targetKind, id: job.targetId, entityTypeId: job.targetEntityTypeId }
  const res = await deps.executeTriggerViaRest(target, call, { triggerCode: job.triggerCode })
  if (res.applied) return
  if (res.skipped === 'unsupported') {
    // Malformed CODE mask / unsupported target — a retry can't succeed. Drop (numeric-safe log).
    console.warn('[trigger] %s#%s: unsupported (bad CODE/target) — dropped from retry queue', job.targetKind, job.targetId)
    return
  }
  throw new Error(`trigger retry: not confirmed for ${job.targetKind}#${job.targetId} — retry`)
}
