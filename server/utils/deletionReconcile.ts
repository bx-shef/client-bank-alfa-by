// Pure consumer for a CRM deletion job — reconciles the SP-ledger after an entity is deleted in
// B24 (#109, PROCESSING.md §9.2). Routing + gating is pure and DI; the actual ledger REST work
// (list distributions, deactivate rows, recompute «осталось», error-chat write) is injected — the
// worker wires the live transport (the ledger slice), so this module is unit-testable without pg /
// network. The classification uses the SAME `classifyDeletionKind` the webhook parser uses, but
// runs HERE (not at ingestion) because it needs the portal's SP config (entityTypeIds from settings).
//
// §9.2 reactions by kind:
//   deal / invoice (amount/trigger target) → free the distributions pointing at it (recompute the
//     parent payment's «осталось» ↑, deactivate the ledger row; manual → «требует распределения»=Y);
//   company                               → scope/owner lost → error chat;
//   payment-carrier (our payment SP)       → §5 carrier damage → error chat;
//   distribution (our ledger row)          → lazily recompute the parent payment;
//   other / unclassifiable                 → skip (not our ledger).

import type { DeletionSpConfig, DeletionEntityKind } from '../../app/utils/deletionEvent'
import { classifyDeletionKind } from '../../app/utils/deletionEvent'
import type { DeletionJob } from '../queue/topology'

/** Injected side effects for {@link handleDeletionJob} — the live ledger transport (ledger slice). */
export interface DeletionReconcileDeps {
  /** Is the portal still installed (its token exists)? A deleted portal ⇒ drop the packet (§9.2 #1). */
  portalInstalled: (memberId: string) => Promise<boolean>
  /** Load the portal's SP config (payment/distribution entityTypeIds) for classification. */
  loadSpConfig: (memberId: string) => Promise<DeletionSpConfig>
  /** Reconcile an amount/trigger TARGET deletion (deal/invoice): deactivate the distributions
   *  pointing at it + recompute their parent payments + notify. Returns rows affected. */
  reconcileTargetDeletion: (job: DeletionJob, kind: DeletionEntityKind) => Promise<number>
  /** A deleted company that scoped a payment — error chat (§5, responsible/scope lost). */
  notifyCompanyDeleted: (job: DeletionJob) => Promise<void>
  /** Our payment-carrier SP element was deleted — §5 structure damage → error chat. */
  notifyCarrierDamaged: (job: DeletionJob) => Promise<void>
  /** A ledger row (dist-SP child) deleted by an admin — lazily recompute its parent payment. */
  recomputeParent: (job: DeletionJob) => Promise<void>
}

/** What the reconcile did — for logging / telemetry / counters (no PII). */
export type DeletionOutcome
  = | 'dropped-uninstalled'
    | 'skipped-irrelevant'
    | 'reconciled-target'
    | 'notified-company'
    | 'notified-carrier'
    | 'recomputed-parent'

export interface DeletionResult {
  outcome: DeletionOutcome
  /** The classified kind (absent when unclassifiable / portal gone). */
  kind?: DeletionEntityKind
  /** Ledger rows affected (only for `reconciled-target`). */
  affected?: number
}

/**
 * Reconcile one deletion job against the SP-ledger. Gates first on the portal still being installed
 * (a deleted portal keeps no ledger), then classifies with the portal's SP config, then routes by
 * kind. Idempotency is the transport's (it reads B24 state — an already-`reverted` row is a no-op)
 * plus the queue's `deletionJobId` dedup. A transport error propagates (BullMQ retries the job).
 */
export async function handleDeletionJob(job: DeletionJob, deps: DeletionReconcileDeps): Promise<DeletionResult> {
  if (!(await deps.portalInstalled(job.memberId))) return { outcome: 'dropped-uninstalled' }

  const cfg = await deps.loadSpConfig(job.memberId)
  const kind = classifyDeletionKind(job.eventCode, job.entityTypeId, cfg)
  if (!kind || kind === 'other') return { outcome: 'skipped-irrelevant', kind: kind ?? undefined }

  switch (kind) {
    case 'deal':
    case 'invoice': {
      const affected = await deps.reconcileTargetDeletion(job, kind)
      return { outcome: 'reconciled-target', kind, affected }
    }
    case 'company':
      await deps.notifyCompanyDeleted(job)
      return { outcome: 'notified-company', kind }
    case 'payment-carrier':
      await deps.notifyCarrierDamaged(job)
      return { outcome: 'notified-carrier', kind }
    case 'distribution':
      await deps.recomputeParent(job)
      return { outcome: 'recomputed-parent', kind }
  }
}
