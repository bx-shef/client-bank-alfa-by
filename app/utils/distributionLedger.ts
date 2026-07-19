// Pure builders for the distribution LEDGER in the smart processes (#109, PROCESSING.md §9.1/§9.3).
// A committed allocation is ONE child element in the distributions SP (`crm.item.add`) linked to the
// payment carrier element (`parentId<paymentSpEtid>`), carrying the amount (`opportunity`) + our UF
// fields (target kind/id, source, status, dedup marker). Idempotency is the marker (find-before-add,
// like the activity marker #259). The payment carrier's «осталось распределить» field is recomputed
// as `total − Σ active` (via the shared `distributionSummary`). No I/O — the REST calls are the
// transport slice (`server/utils/distributionLedgerWrite.ts`); these builders are the single source
// of the ledger wire shape and are unit-tested. Mirrors the sync-payments child-add (parentId<sp>,
// opportunity, currencyId, isManualOpportunity:'Y').
//
// ⚠ LIVE-VERIFY before the hot-path wiring slice: (1) `useOriginalUfNames:'Y'` actually round-trips
// our `UF_CRM_<etid>_<POSTFIX>` names on write/read/filter (crm.item.* default is camelCase); (2)
// `crm.item.list` can FILTER by `parentId<etid>` (only SELECT of `parentId2` is live-confirmed in
// this repo). If either fails live, switch to camelCase UF names / a different parent filter.

import type { AllocationTargetKind } from './allocation'
import type { AllocationSource, DistributionEntry } from './manualAllocation'
import { distributionSummary } from './manualAllocation'
import { round2 } from './money'
import { DISTRIBUTION_SP_FIELDS, PAYMENT_SP_FIELDS, buildUfFieldName } from '~/config/distributionSp'

/** The parent-link field name for a child element in the distributions SP: `parentId<paymentSpEtid>`
 *  (B24 smart-process parent reference, confirmed in sync-payments — `parentId1036`). */
export function parentLinkField(paymentSpEtid: number): string {
  return `parentId${paymentSpEtid}`
}

/** Everything needed to write one distribution row. `paymentElementId` is the payment carrier SP
 *  element (the parent); `marker` is the idempotent allocation-fact key. */
export interface DistributionRowInput {
  paymentSpEtid: number
  distributionSpEtid: number
  paymentElementId: string
  amount: number
  currency: string
  targetKind: AllocationTargetKind
  targetId: string
  source: AllocationSource
  marker: string
}

/** Build the `crm.item.add` call that creates one distribution ledger row. `isManualOpportunity:'Y'`
 *  so the amount isn't recomputed from products (there are none — it's an accounting row). */
export function buildDistributionRowAddCall(input: DistributionRowInput): { method: string, params: Record<string, unknown> } {
  const etid = input.distributionSpEtid
  const uf = (postfix: string) => buildUfFieldName(etid, postfix)
  return {
    method: 'crm.item.add',
    params: {
      entityTypeId: etid,
      // crm.item.* defaults to camelCase UF names (useOriginalUfNames:'N'); we use the ORIGINAL
      // `UF_CRM_<etid>_<POSTFIX>` names everywhere (shared with provisioning) → force 'Y' so the
      // write/read/filter names all agree (else the marker filter never matches → dedup breaks).
      useOriginalUfNames: 'Y',
      fields: {
        [parentLinkField(input.paymentSpEtid)]: Number(input.paymentElementId),
        opportunity: round2(input.amount),
        currencyId: input.currency,
        isManualOpportunity: 'Y',
        [uf(DISTRIBUTION_SP_FIELDS.targetKind.postfix)]: input.targetKind,
        [uf(DISTRIBUTION_SP_FIELDS.targetId.postfix)]: input.targetId,
        [uf(DISTRIBUTION_SP_FIELDS.source.postfix)]: input.source,
        [uf(DISTRIBUTION_SP_FIELDS.status.postfix)]: 'active',
        [uf(DISTRIBUTION_SP_FIELDS.marker.postfix)]: input.marker
      }
    }
  }
}

/** Build the `crm.item.list` call that finds a distribution row by its dedup marker (idempotency
 *  probe — one row per allocation fact). Selects only the id. */
export function buildMarkerListCall(distributionSpEtid: number, marker: string): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: distributionSpEtid,
      useOriginalUfNames: 'Y', // filter/read by the original UF names (see buildDistributionRowAddCall)
      filter: { [buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.marker.postfix)]: marker },
      select: ['id']
    }
  }
}

/** Build the `crm.item.list` call for the ACTIVE distribution rows of one payment element (its
 *  children with status=active) — the input to the «осталось» recompute. `start` paginates. */
export function buildActiveRowsListCall(
  distributionSpEtid: number,
  paymentSpEtid: number,
  paymentElementId: string,
  start?: number
): { method: string, params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    entityTypeId: distributionSpEtid,
    useOriginalUfNames: 'Y', // filter/read/select by the original UF names (see buildDistributionRowAddCall)
    filter: {
      [parentLinkField(paymentSpEtid)]: Number(paymentElementId),
      [buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.status.postfix)]: 'active'
    },
    select: ['id', 'opportunity', 'currencyId',
      buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.targetKind.postfix),
      buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.targetId.postfix),
      buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.source.postfix),
      buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.status.postfix)]
  }
  if (start) params.start = start
  return { method: 'crm.item.list', params }
}

/** Build the `crm.item.list` for ALL distribution rows of one payment element (any status — active
 *  AND reverted, for the UI history), by parent link. `start` paginates. Same select as the active
 *  list (adds nothing status-specific). */
export function buildPaymentRowsListCall(
  distributionSpEtid: number,
  paymentSpEtid: number,
  paymentElementId: string,
  start?: number
): { method: string, params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    entityTypeId: distributionSpEtid,
    useOriginalUfNames: 'Y',
    filter: { [parentLinkField(paymentSpEtid)]: Number(paymentElementId) },
    select: ['id', 'opportunity', 'currencyId',
      buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.targetKind.postfix),
      buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.targetId.postfix),
      buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.source.postfix),
      buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.status.postfix)]
  }
  if (start) params.start = start
  return { method: 'crm.item.list', params }
}

/** Build the `crm.item.list` for ALL payment carrier elements of the portal (for the «Распределение»
 *  UI), newest first, paginated. Selects the total + currency + our UF state fields. */
export function buildPaymentListCall(paymentSpEtid: number, start?: number): { method: string, params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    entityTypeId: paymentSpEtid,
    useOriginalUfNames: 'Y',
    order: { id: 'desc' },
    select: ['id', 'opportunity', 'currencyId', 'companyId',
      buildUfFieldName(paymentSpEtid, PAYMENT_SP_FIELDS.needDistributionsSum.postfix),
      buildUfFieldName(paymentSpEtid, PAYMENT_SP_FIELDS.requiresRedistribution.postfix),
      buildUfFieldName(paymentSpEtid, PAYMENT_SP_FIELDS.marker.postfix)]
  }
  if (start) params.start = start
  return { method: 'crm.item.list', params }
}

/** Parse one payment carrier list item into a header for the UI card. */
export interface PaymentCarrierHeader {
  id: string
  total: number
  currency: string
  requiresRedistribution: boolean
}

/** Parse a payment carrier list item (`buildPaymentListCall`) into a {@link PaymentCarrierHeader}. */
export function parsePaymentCarrier(item: Record<string, unknown>, paymentSpEtid: number): PaymentCarrierHeader | null {
  const id = item.id
  if (id === undefined || id === null || `${id}` === '') return null
  const total = Number(item.opportunity)
  return {
    id: `${id}`,
    total: Number.isFinite(total) ? round2(total) : 0,
    currency: String(item.currencyId ?? ''),
    requiresRedistribution: String(item[buildUfFieldName(paymentSpEtid, PAYMENT_SP_FIELDS.requiresRedistribution.postfix)] ?? '') === 'Y'
  }
}

/** Parse one distribution ledger item (from `crm.item.list`) into a `DistributionEntry`. Reads our
 *  UF fields (by full name) + the built-in `opportunity`/`currencyId`. Non-finite amount → 0. */
export function parseLedgerRow(item: Record<string, unknown>, distributionSpEtid: number): DistributionEntry {
  const uf = (postfix: string) => item[buildUfFieldName(distributionSpEtid, postfix)]
  const amount = Number(item.opportunity)
  return {
    targetKind: String(uf(DISTRIBUTION_SP_FIELDS.targetKind.postfix) ?? '') as AllocationTargetKind,
    targetId: String(uf(DISTRIBUTION_SP_FIELDS.targetId.postfix) ?? ''),
    amount: Number.isFinite(amount) ? round2(amount) : 0,
    currency: String(item.currencyId ?? ''),
    source: (String(uf(DISTRIBUTION_SP_FIELDS.source.postfix) ?? 'auto') === 'manual' ? 'manual' : 'auto'),
    status: (String(uf(DISTRIBUTION_SP_FIELDS.status.postfix) ?? 'active') === 'reverted' ? 'reverted' : 'active')
  }
}

/** Compute the «осталось распределить» value for a payment: `total − Σ active` (clamped ≥0), via the
 *  shared `distributionSummary`. `rows` are the active ledger entries (already parsed). */
export function computeNeedDistribution(total: number, currency: string, rows: readonly DistributionEntry[]): number {
  return distributionSummary(total, currency, rows).remaining
}

/** Build the `crm.item.update` call that writes the recomputed «осталось» onto the payment carrier
 *  element. */
export function buildNeedRecomputeCall(
  paymentSpEtid: number,
  paymentElementId: string,
  remaining: number
): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: paymentSpEtid,
      id: Number(paymentElementId),
      useOriginalUfNames: 'Y', // write the original UF name (see buildDistributionRowAddCall)
      fields: { [buildUfFieldName(paymentSpEtid, PAYMENT_SP_FIELDS.needDistributionsSum.postfix)]: round2(remaining) }
    }
  }
}

/** Build the `crm.item.list` call for the ACTIVE distribution rows pointing at a given TARGET
 *  (`targetKind` + `targetId`) — the input to a target-deletion reconcile (§9.2: a deleted deal/
 *  invoice frees the distributions on it). Selects the parent link (so the caller knows which
 *  payment to recompute) + source (manual vs auto → §3). `start` paginates. */
export function buildTargetRowsListCall(
  distributionSpEtid: number,
  paymentSpEtid: number,
  targetKind: AllocationTargetKind,
  targetId: string,
  start?: number
): { method: string, params: Record<string, unknown> } {
  const uf = (postfix: string) => buildUfFieldName(distributionSpEtid, postfix)
  const params: Record<string, unknown> = {
    entityTypeId: distributionSpEtid,
    useOriginalUfNames: 'Y',
    filter: {
      [uf(DISTRIBUTION_SP_FIELDS.targetKind.postfix)]: targetKind,
      [uf(DISTRIBUTION_SP_FIELDS.targetId.postfix)]: targetId,
      [uf(DISTRIBUTION_SP_FIELDS.status.postfix)]: 'active'
    },
    select: ['id', parentLinkField(paymentSpEtid), uf(DISTRIBUTION_SP_FIELDS.source.postfix)]
  }
  if (start) params.start = start
  return { method: 'crm.item.list', params }
}

/** One active distribution row keyed for reconcile: its own id, its parent payment element id, and
 *  whether it was a manual allocation (drives the «требует распределения» flag on the parent, §3). */
export interface TargetRowRef {
  rowId: string
  parentPaymentId: string
  source: AllocationSource
}

/** Parse a target-row list item (from `buildTargetRowsListCall`) into a {@link TargetRowRef}, or
 *  `null` when the row/parent id is missing. */
export function parseTargetRow(item: Record<string, unknown>, distributionSpEtid: number, paymentSpEtid: number): TargetRowRef | null {
  const rowId = item.id
  const parent = item[parentLinkField(paymentSpEtid)]
  if (rowId === undefined || rowId === null || `${rowId}` === '') return null
  if (parent === undefined || parent === null || `${parent}` === '') return null
  const source = String(item[buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.source.postfix)] ?? 'auto') === 'manual' ? 'manual' : 'auto'
  return { rowId: `${rowId}`, parentPaymentId: `${parent}`, source }
}

/** Build the `crm.item.update` that DEACTIVATES a distribution row (`status → reverted`, history kept
 *  — we never hard-delete, §9.2). */
export function buildDeactivateRowCall(distributionSpEtid: number, rowId: string): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: distributionSpEtid,
      id: Number(rowId),
      useOriginalUfNames: 'Y',
      fields: { [buildUfFieldName(distributionSpEtid, DISTRIBUTION_SP_FIELDS.status.postfix)]: 'reverted' }
    }
  }
}

/** Build the `crm.item.update` that sets «требует распределения» (Y/N) on a payment carrier element
 *  (§3: raised when a MANUAL distribution was freed by a target change/deletion). */
export function buildRequiresRedistributionCall(
  paymentSpEtid: number,
  paymentElementId: string,
  value: boolean
): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: paymentSpEtid,
      id: Number(paymentElementId),
      useOriginalUfNames: 'Y',
      fields: { [buildUfFieldName(paymentSpEtid, PAYMENT_SP_FIELDS.requiresRedistribution.postfix)]: value ? 'Y' : 'N' }
    }
  }
}

/** Build the `crm.item.list` that reads a payment carrier element by id — for its `opportunity`
 *  (the total) + `currencyId`, needed to recompute «осталось». */
export function buildPaymentReadCall(paymentSpEtid: number, paymentElementId: string): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: paymentSpEtid,
      filter: { id: Number(paymentElementId) },
      select: ['id', 'opportunity', 'currencyId']
    }
  }
}

/** Extract `{ total, currency }` from a payment-read list item. Non-finite total → 0. */
export function parsePaymentTotal(item: Record<string, unknown> | undefined): { total: number, currency: string } {
  const total = Number(item?.opportunity)
  return { total: Number.isFinite(total) ? round2(total) : 0, currency: String(item?.currencyId ?? '') }
}

/** Input for creating a payment CARRIER element (the SP element that holds one incoming payment). */
export interface PaymentElementInput {
  /** The payment's full amount (`opportunity`). */
  opportunity: number
  /** ISO currency. */
  currency: string
  /** Operation dedup marker (`dedupKey` = account|docId) — idempotent write-once carrier per op. */
  marker: string
  /** CRM company id (payer), when matched — links the client (isClientEnabled). Optional. */
  companyId?: string
}

/** Build the `crm.item.add` call that creates the payment CARRIER element. «Осталось распределить»
 *  starts at the full amount (nothing distributed yet); the client link is set when a company matched. */
export function buildPaymentElementAddCall(paymentSpEtid: number, input: PaymentElementInput): { method: string, params: Record<string, unknown> } {
  const amount = round2(input.opportunity)
  const fields: Record<string, unknown> = {
    opportunity: amount,
    currencyId: input.currency,
    isManualOpportunity: 'Y',
    [buildUfFieldName(paymentSpEtid, PAYMENT_SP_FIELDS.needDistributionsSum.postfix)]: amount,
    [buildUfFieldName(paymentSpEtid, PAYMENT_SP_FIELDS.marker.postfix)]: input.marker
  }
  // Link the payer company only when matched (a positive integer id).
  const companyId = Number(input.companyId)
  if (input.companyId && Number.isInteger(companyId) && companyId > 0) fields.companyId = companyId
  return {
    method: 'crm.item.add',
    params: { entityTypeId: paymentSpEtid, useOriginalUfNames: 'Y', fields }
  }
}

/** Build the `crm.item.list` that finds a payment carrier element by its operation marker (idempotency
 *  probe — one carrier per operation). Selects id + opportunity + currency (for a later recompute). */
export function buildPaymentMarkerListCall(paymentSpEtid: number, marker: string): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: paymentSpEtid,
      useOriginalUfNames: 'Y',
      filter: { [buildUfFieldName(paymentSpEtid, PAYMENT_SP_FIELDS.marker.postfix)]: marker },
      select: ['id', 'opportunity', 'currencyId']
    }
  }
}
