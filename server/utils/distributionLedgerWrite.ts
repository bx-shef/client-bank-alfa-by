// Transport for the distribution SP-ledger (#109, PROCESSING.md §9.1/§9.3): write a distribution
// row (idempotent by marker), load a payment's active rows, and recompute its «осталось распределить».
// DI over the injected `RestCall` — unit-testable with a fake. All wire shapes come from the shared,
// tested builders in app/utils/distributionLedger.ts; this module only does REST + result extraction
// + pagination. Wired into crm-sync (`writeLedgerAllocation` at `allocate`, behind autoDistribute +
// provisioned SP) and into the deletion consumer (`reconcileTargetDeletion`).

import type { StatementItem } from '../../app/types/statement'
import type { AllocationCandidate, AllocationTargetKind } from '../../app/utils/allocation'
import { allocationFactKey } from '../../app/utils/allocation'
import { dedupKey } from '../../app/utils/statement'
import type { DistributionEntry } from '../../app/utils/manualAllocation'
import {
  buildActiveRowsListCall,
  buildDeactivateRowCall,
  buildDistributionRowAddCall,
  buildMarkerListCall,
  buildNeedRecomputeCall,
  buildPaymentElementAddCall,
  buildPaymentListCall,
  buildPaymentMarkerListCall,
  buildPaymentReadCall,
  buildPaymentRowsListCall,
  buildRequiresRedistributionCall,
  buildTargetRowsListCall,
  computeNeedDistribution,
  parseLedgerRow,
  parsePaymentCarrier,
  parsePaymentTotal,
  parseTargetRow,
  type DistributionRowInput,
  type PaymentCarrierHeader,
  type PaymentElementInput,
  type TargetRowRef
} from '../../app/utils/distributionLedger'
import type { SpRef } from '../../app/config/distributionSp'
import type { RestCall } from './companyLookup'

/** Page-loop backstop for a payment's active rows (a payment with more than this many active
 *  distributions is pathological; the cap only bounds a runaway `next`). */
export const MAX_LEDGER_PAGES = 100

/** Extract the created item id from a `crm.item.add` response (`{result:{item:{id}}}`). */
export function extractAddedItemId(resp: Record<string, unknown>): string | null {
  const item = (resp?.result as { item?: unknown } | undefined)?.item
  const id = (item as { id?: unknown } | undefined)?.id
  return id !== undefined && id !== null && `${id}` !== '' ? `${id}` : null
}

/** Extract the `items` array from a `crm.item.list` response (tolerant of shape). */
export function extractListItems(resp: Record<string, unknown>): Record<string, unknown>[] {
  const items = (resp?.result as { items?: unknown } | undefined)?.items
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : []
}

/** Read the `next` page offset from a list response (absent/invalid ends pagination). */
function nextOffset(resp: Record<string, unknown>): number | null {
  const n = Number((resp as { next?: unknown })?.next)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Find an existing distribution row id by its dedup marker, or `null`. Empty marker → `null`
 *  without a REST call (an empty filter would list every row). */
export async function findDistributionByMarker(distributionSp: SpRef, marker: string, call: RestCall): Promise<string | null> {
  if (!marker) return null
  const listCall = buildMarkerListCall(distributionSp, marker)
  const resp = await call(listCall.method, listCall.params)
  const first = extractListItems(resp)[0]
  const id = first?.id
  return id !== undefined && id !== null && `${id}` !== '' ? `${id}` : null
}

/** Write one distribution row idempotently: if a row with the same marker already exists, return it
 *  (`created:false`) without adding a duplicate; else `crm.item.add` and return the new id. */
export async function writeDistributionRow(input: DistributionRowInput, call: RestCall): Promise<{ id: string, created: boolean }> {
  const existing = await findDistributionByMarker(input.distributionSp, input.marker, call)
  if (existing) return { id: existing, created: false }
  const addCall = buildDistributionRowAddCall(input)
  const resp = await call(addCall.method, addCall.params)
  const id = extractAddedItemId(resp)
  if (!id) throw new Error('crm.item.add returned no distribution row id')
  return { id, created: true }
}

/** Find an existing payment CARRIER element id by its operation marker, or `null`. Empty marker →
 *  `null` without a REST call. */
export async function findPaymentByMarker(paymentSp: SpRef, marker: string, call: RestCall): Promise<string | null> {
  if (!marker) return null
  const listCall = buildPaymentMarkerListCall(paymentSp, marker)
  const resp = await call(listCall.method, listCall.params)
  const id = extractListItems(resp)[0]?.id
  return id !== undefined && id !== null && `${id}` !== '' ? `${id}` : null
}

/** Ensure the payment carrier element for an operation exists: return it if a row with the same
 *  operation marker is already present (`created:false`), else `crm.item.add` and return the new id.
 *  Idempotent write-once per operation (mirrors the activity marker, #259). */
export async function ensurePaymentElement(paymentSp: SpRef, input: PaymentElementInput, call: RestCall): Promise<{ id: string, created: boolean }> {
  const existing = await findPaymentByMarker(paymentSp, input.marker, call)
  if (existing) return { id: existing, created: false }
  const addCall = buildPaymentElementAddCall(paymentSp, input)
  const resp = await call(addCall.method, addCall.params)
  const id = extractAddedItemId(resp)
  if (!id) throw new Error('crm.item.add returned no payment element id')
  return { id, created: true }
}

/** Load ALL active distribution rows of a payment element (paginated), parsed to entries. */
export async function loadActiveDistributions(
  distributionSp: SpRef,
  paymentSp: SpRef,
  paymentElementId: string,
  call: RestCall
): Promise<DistributionEntry[]> {
  const rows: DistributionEntry[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_LEDGER_PAGES && start !== null; page++) {
    const listCall = buildActiveRowsListCall(distributionSp, paymentSp, paymentElementId, start || undefined)
    const resp = await call(listCall.method, listCall.params)
    for (const item of extractListItems(resp)) rows.push(parseLedgerRow(item, distributionSp))
    start = nextOffset(resp)
  }
  return rows
}

/**
 * Recompute a payment's «осталось распределить» from its active ledger rows and write it onto the
 * payment carrier element. Returns the recomputed remaining. Idempotent — re-running with the same
 * ledger writes the same value.
 */
export async function recomputeNeedDistribution(
  paymentSp: SpRef,
  paymentElementId: string,
  distributionSp: SpRef,
  total: number,
  currency: string,
  call: RestCall
): Promise<number> {
  const rows = await loadActiveDistributions(distributionSp, paymentSp, paymentElementId, call)
  const remaining = computeNeedDistribution(total, currency, rows)
  const updateCall = buildNeedRecomputeCall(paymentSp, paymentElementId, remaining)
  await call(updateCall.method, updateCall.params)
  return remaining
}

/** Read a payment carrier element's total (`opportunity`) + currency. `null` when the element is
 *  gone (e.g. the whole payment was deleted) — the caller then has nothing to recompute. */
export async function readPaymentTotal(paymentSp: SpRef, paymentElementId: string, call: RestCall): Promise<{ total: number, currency: string } | null> {
  const readCall = buildPaymentReadCall(paymentSp, paymentElementId)
  const resp = await call(readCall.method, readCall.params)
  const item = extractListItems(resp)[0]
  return item ? parsePaymentTotal(item) : null
}

/** Load ALL active distribution rows pointing at a TARGET (`targetKind`+`targetId`), paginated. */
export async function loadDistributionsByTarget(
  distributionSp: SpRef,
  paymentSp: SpRef,
  targetKind: AllocationTargetKind,
  targetId: string,
  call: RestCall
): Promise<TargetRowRef[]> {
  const refs: TargetRowRef[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_LEDGER_PAGES && start !== null; page++) {
    const listCall = buildTargetRowsListCall(distributionSp, paymentSp, targetKind, targetId, start || undefined)
    const resp = await call(listCall.method, listCall.params)
    for (const item of extractListItems(resp)) {
      const ref = parseTargetRow(item, distributionSp, paymentSp)
      if (ref) refs.push(ref)
    }
    start = nextOffset(resp)
  }
  return refs
}

/** Outcome of a target-deletion reconcile (§9.2): how many rows were freed + how many parent
 *  payments were recomputed (and how many were flagged «требует распределения» for a manual free). */
export interface TargetReconcileResult {
  freed: number
  parentsRecomputed: number
  manualParents: number
}

/**
 * Reconcile a deleted amount/trigger target (deal/invoice, §9.2): deactivate every ACTIVE
 * distribution row pointing at it (`status → reverted`, history kept), then for each affected parent
 * payment recompute «осталось» (freed amount returns) and, when a MANUAL row was freed, raise «требует
 * распределения»=Y (§3; auto rows are silently cleaned, no flag). Idempotent — an already-reverted
 * ledger yields 0 rows and recomputes to the same values. A parent whose payment element is gone (the
 * whole payment was deleted) is skipped (nothing to recompute). Returns the counts.
 *
 * ⚠ Crash-window: rows are reverted BEFORE the per-parent recompute; a crash between the two means a
 * BullMQ retry re-reads active rows (now []) and returns early WITHOUT redoing the recompute/flag for
 * those parents. That leaves a stale «осталось» on the affected payment — recovered by the manual
 * «пересчитать» button (§3/§9.2, the spec's backstop for exactly this), not by the retry.
 */
export async function reconcileTargetDeletion(
  paymentSp: SpRef,
  distributionSp: SpRef,
  targetKind: AllocationTargetKind,
  targetId: string,
  call: RestCall
): Promise<TargetReconcileResult> {
  const rows = await loadDistributionsByTarget(distributionSp, paymentSp, targetKind, targetId, call)
  if (rows.length === 0) return { freed: 0, parentsRecomputed: 0, manualParents: 0 }

  // Deactivate every matching row first (so the recompute below sees them as freed).
  for (const row of rows) {
    const deact = buildDeactivateRowCall(distributionSp, row.rowId)
    await call(deact.method, deact.params)
  }

  // Group affected parents; a parent is "manual-affected" if ANY freed row on it was manual (§3).
  const manualParents = new Set<string>()
  const parents = new Set<string>()
  for (const row of rows) {
    parents.add(row.parentPaymentId)
    if (row.source === 'manual') manualParents.add(row.parentPaymentId)
  }

  let parentsRecomputed = 0
  for (const parentId of parents) {
    const payment = await readPaymentTotal(paymentSp, parentId, call)
    if (!payment) continue // the whole payment element is gone — nothing to recompute
    await recomputeNeedDistribution(paymentSp, parentId, distributionSp, payment.total, payment.currency, call)
    parentsRecomputed++
    if (manualParents.has(parentId)) {
      const flag = buildRequiresRedistributionCall(paymentSp, parentId, true)
      await call(flag.method, flag.params)
    }
  }

  return { freed: rows.length, parentsRecomputed, manualParents: manualParents.size }
}

/** Result of writing one allocation to the SP-ledger. */
export interface LedgerAllocationResult {
  paymentElementId: string
  rowId: string
  /** False when the distribution row already existed (idempotent redelivery). */
  rowCreated: boolean
  /** «осталось распределить» after this allocation. */
  remaining: number
}

/**
 * Write ONE auto-allocation to the SP-ledger (§9.1/§9.3): ensure the payment carrier element for the
 * operation (idempotent by operation marker), add the distribution row for the decided target
 * (idempotent by allocation-fact marker), and recompute «осталось» on the carrier. The whole thing is
 * idempotent — a redelivered batch finds both the carrier and the row already present and recomputes
 * to the same value. `op.amount` is the payment total; the row amount is the amount allocated to the
 * target (for an exact-match auto-allocate that equals `op.amount`). Errors propagate (BullMQ retries).
 */
export async function writeLedgerAllocation(
  paymentSp: SpRef,
  distributionSp: SpRef,
  op: StatementItem,
  target: AllocationCandidate,
  companyId: string | undefined,
  call: RestCall
): Promise<LedgerAllocationResult> {
  const payment = await ensurePaymentElement(paymentSp, {
    opportunity: op.amount,
    currency: op.currency,
    marker: dedupKey(op),
    companyId
  }, call)

  const row = await writeDistributionRow({
    paymentSp,
    distributionSp,
    paymentElementId: payment.id,
    amount: op.amount,
    currency: op.currency,
    targetKind: target.kind,
    targetId: target.id,
    source: 'auto',
    marker: allocationFactKey(op, target)
  }, call)

  const remaining = await recomputeNeedDistribution(paymentSp, payment.id, distributionSp, op.amount, op.currency, call)

  return { paymentElementId: payment.id, rowId: row.id, rowCreated: row.created, remaining }
}

/** Whether a TRIGGER fire for this (payment → deal/smart-process target) is already recorded in the
 *  SP-ledger — a distribution row with the trigger's allocation-fact marker exists (#109 §9.3 #6).
 *  This replaces the Postgres `hasAllocationFact` dedup for the trigger path: the marker lives on the
 *  dist-СП row, so a redelivery/retry that already fired finds it and skips. Empty marker → false. */
export async function hasTriggerLedgerFact(distributionSp: SpRef, op: StatementItem, target: AllocationCandidate, call: RestCall): Promise<boolean> {
  return (await findDistributionByMarker(distributionSp, allocationFactKey(op, target), call)) !== null
}

/** Record a fired TRIGGER (deal/smart-process, #79) in the SP-ledger (#109 §9.3 #6): ensure the
 *  payment carrier element for the operation, then add a ZERO-amount distribution row for the trigger
 *  target, idempotent by the allocation-fact marker. Zero amount so it does NOT consume «осталось»
 *  (a trigger only SIGNALS money arrived — it allocates nothing) and no recompute is needed; the row
 *  is purely the durable dedup marker + audit record («триггер отправлен»). Returns whether a NEW row
 *  was created (redelivery finds it and returns false). Errors propagate (clean BullMQ retry). */
export async function writeTriggerLedgerFact(
  paymentSp: SpRef,
  distributionSp: SpRef,
  op: StatementItem,
  target: AllocationCandidate,
  companyId: string | undefined,
  call: RestCall
): Promise<{ created: boolean }> {
  const payment = await ensurePaymentElement(paymentSp, {
    opportunity: op.amount,
    currency: op.currency,
    marker: dedupKey(op),
    companyId
  }, call)

  const row = await writeDistributionRow({
    paymentSp,
    distributionSp,
    paymentElementId: payment.id,
    amount: 0,
    currency: op.currency,
    targetKind: target.kind,
    targetId: target.id,
    source: 'auto',
    marker: allocationFactKey(op, target)
  }, call)

  return { created: row.created }
}

/** Page cap for the portal ledger read (UI). A portal with more than this many payment carriers is
 *  paged off — the UI shows the newest; a full audit is a separate concern. */
export const MAX_LEDGER_PAYMENTS = 200

/** One payment carrier + its distribution rows, for the «Распределение» UI. */
export interface LedgerCard {
  id: string
  total: number
  currency: string
  requiresRedistribution: boolean
  rows: DistributionEntry[]
}

/** List ALL distribution rows (any status) of one payment element, paginated. */
async function loadAllRows(distributionSp: SpRef, paymentSp: SpRef, paymentElementId: string, call: RestCall): Promise<DistributionEntry[]> {
  const rows: DistributionEntry[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_LEDGER_PAGES && start !== null; page++) {
    const listCall = buildPaymentRowsListCall(distributionSp, paymentSp, paymentElementId, start || undefined)
    const resp = await call(listCall.method, listCall.params)
    for (const item of extractListItems(resp)) rows.push(parseLedgerRow(item, distributionSp))
    start = nextOffset(resp)
  }
  return rows
}

/**
 * Read the portal's distribution ledger for the UI: the newest payment carrier elements (up to
 * `MAX_LEDGER_PAYMENTS`) each with ALL their distribution rows (active + reverted, for history). Pure
 * over the injected `call`. Errors propagate (the route maps them to 502). Ordered newest-first.
 */
export async function loadPortalLedger(paymentSp: SpRef, distributionSp: SpRef, call: RestCall): Promise<LedgerCard[]> {
  const headers: PaymentCarrierHeader[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_LEDGER_PAGES && start !== null && headers.length < MAX_LEDGER_PAYMENTS; page++) {
    const listCall = buildPaymentListCall(paymentSp, start || undefined)
    const resp = await call(listCall.method, listCall.params)
    for (const item of extractListItems(resp)) {
      const header = parsePaymentCarrier(item, paymentSp)
      if (header) headers.push(header)
      if (headers.length >= MAX_LEDGER_PAYMENTS) break
    }
    start = nextOffset(resp)
  }

  const cards: LedgerCard[] = []
  for (const header of headers) {
    const rows = await loadAllRows(distributionSp, paymentSp, header.id, call)
    cards.push({ id: header.id, total: header.total, currency: header.currency, requiresRedistribution: header.requiresRedistribution, rows })
  }
  return cards
}

/**
 * Recompute «осталось распределить» for EVERY payment carrier of the portal (§3/§9.2 manual
 * «пересчитать» — the recovery backstop for the deletion crash-window and any drift). Lists the
 * carriers (paginated, capped at MAX_LEDGER_PAYMENTS) and recomputes each from its active rows.
 * Returns how many were recomputed. Idempotent (recompute-from-state). Errors propagate (retry).
 */
export async function recomputeAllPayments(paymentSp: SpRef, distributionSp: SpRef, call: RestCall): Promise<number> {
  const headers: PaymentCarrierHeader[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_LEDGER_PAGES && start !== null && headers.length < MAX_LEDGER_PAYMENTS; page++) {
    const listCall = buildPaymentListCall(paymentSp, start || undefined)
    const resp = await call(listCall.method, listCall.params)
    for (const item of extractListItems(resp)) {
      const header = parsePaymentCarrier(item, paymentSp)
      if (header) headers.push(header)
      if (headers.length >= MAX_LEDGER_PAYMENTS) break
    }
    start = nextOffset(resp)
  }

  let recomputed = 0
  for (const header of headers) {
    await recomputeNeedDistribution(paymentSp, header.id, distributionSp, header.total, header.currency, call)
    recomputed++
  }
  return recomputed
}
