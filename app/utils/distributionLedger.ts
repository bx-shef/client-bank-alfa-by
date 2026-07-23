// Pure builders for the distribution LEDGER in the smart processes (#109, PROCESSING.md §9.1/§9.3).
// A committed allocation is ONE child element in the distributions SP (`crm.item.add`) linked to the
// payment carrier element via our `PARENT_PAYMENT` UF field (see below), carrying the amount
// (`opportunity`) + our UF fields (target kind/id, source, status, dedup marker). Idempotency is the
// marker (find-before-add, like the activity marker #259). The payment carrier's «осталось
// распределить» field is recomputed as `total − Σ active` (via the shared `distributionSummary`). No
// I/O — the REST calls are the transport slice (`server/utils/distributionLedgerWrite.ts`); these
// builders are the single source of the ledger wire shape and are unit-tested.
//
// SP IDENTITY (live-confirmed, #109): each SP is an {@link SpRef} = { entityTypeId, id }. `crm.item.*`
// uses the entityTypeId; USER FIELDS use the TYPE id — and are addressed by their CAMELCASE names
// (`ufCrm<id><Pascal(postfix)>`, `buildUfFieldNameCamel`), because filtering by the original
// `UF_CRM_<id>_…` name returns EMPTY even with `useOriginalUfNames:'Y'` (live-confirmed — that broke the
// marker dedup). The parent link between a distribution row and its payment carrier is OUR OWN
// filterable UF field (`PARENT_PAYMENT`, integer = payment element id, `parentPaymentField`) — NOT the
// native `parentId<etid>` link, which is rejected in filters because our two SPs have no configured
// parent-child relationship.
//
// MONEY (live-confirmed): the built-in `opportunity`/`currencyId` are NOT writable on a smart-process
// item (they stay 0 / portal-default regardless of `isManualOpportunity`/type flags), so the ledger
// keeps amount + currency in OUR OWN UF fields — the row's AMOUNT (double, `settings.PRECISION:2` so
// kopecks survive — a plain double rounds to integer) + CURRENCY, and the carrier's TOTAL + CURRENCY;
// the «осталось» recompute sums these, not `opportunity`. The full write path (create, field-add,
// carrier/row write, marker dedup, «осталось» recompute) is verified live (`pnpm verify:distribution`).

import type { AllocationTargetKind } from './allocation'
import type { AllocationSource, DistributionEntry } from './manualAllocation'
import { distributionSummary } from './manualAllocation'
import { round2 } from './money'
import { DISTRIBUTION_SP_FIELDS, PAYMENT_SP_FIELDS, buildUfFieldNameCamel, type SpRef } from '~/config/distributionSp'

/** The field that links a distribution row to its parent PAYMENT carrier element: our OWN filterable
 *  UF field (`PARENT_PAYMENT`, integer = the payment element id), by its camelCase name. NOT the native
 *  `parentId<etid>` link — our two SPs have no configured parent-child relationship, so that link
 *  doesn't exist and is rejected in filters (live-confirmed, #109). Keyed on the DISTRIBUTIONS SP id. */
export function parentPaymentField(distributionSp: SpRef): string {
  return buildUfFieldNameCamel(distributionSp.id, DISTRIBUTION_SP_FIELDS.parentPayment.postfix)
}

/** Everything needed to write one distribution row. `paymentElementId` is the payment carrier SP
 *  element (the parent); `marker` is the idempotent allocation-fact key. Both SPs are full refs. */
export interface DistributionRowInput {
  paymentSp: SpRef
  distributionSp: SpRef
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
  const etid = input.distributionSp.entityTypeId
  const uf = (postfix: string) => buildUfFieldNameCamel(input.distributionSp.id, postfix)
  return {
    method: 'crm.item.add',
    params: {
      entityTypeId: etid,
      // Address UF fields by their CAMELCASE names (crm.item.* default) — filtering by the original
      // `UF_CRM_<id>_…` name returns EMPTY (live-confirmed), so write/read/filter all use camelCase.
      fields: {
        [parentPaymentField(input.distributionSp)]: Number(input.paymentElementId),
        // Amount + currency in our OWN fields — the built-in opportunity/currencyId are NOT writable
        // on a smart-process item (live-confirmed: they stay 0 / portal-default), so the recompute
        // sums THESE. The AMOUNT field is a double with PRECISION:2 (kopeck-safe).
        [uf(DISTRIBUTION_SP_FIELDS.amount.postfix)]: round2(input.amount),
        [uf(DISTRIBUTION_SP_FIELDS.currency.postfix)]: input.currency,
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
export function buildMarkerListCall(distributionSp: SpRef, marker: string): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: distributionSp.entityTypeId,
      filter: { [buildUfFieldNameCamel(distributionSp.id, DISTRIBUTION_SP_FIELDS.marker.postfix)]: marker },
      select: ['id']
    }
  }
}

/** Build the `crm.item.list` call for the ACTIVE distribution rows of one payment element (its
 *  children with status=active) — the input to the «осталось» recompute. `start` paginates. */
export function buildActiveRowsListCall(
  distributionSp: SpRef,
  paymentSp: SpRef,
  paymentElementId: string,
  start?: number
): { method: string, params: Record<string, unknown> } {
  const uf = (postfix: string) => buildUfFieldNameCamel(distributionSp.id, postfix)
  const params: Record<string, unknown> = {
    entityTypeId: distributionSp.entityTypeId,
    filter: {
      [parentPaymentField(distributionSp)]: Number(paymentElementId),
      [uf(DISTRIBUTION_SP_FIELDS.status.postfix)]: 'active'
    },
    select: ['id',
      uf(DISTRIBUTION_SP_FIELDS.amount.postfix),
      uf(DISTRIBUTION_SP_FIELDS.currency.postfix),
      uf(DISTRIBUTION_SP_FIELDS.targetKind.postfix),
      uf(DISTRIBUTION_SP_FIELDS.targetId.postfix),
      uf(DISTRIBUTION_SP_FIELDS.source.postfix),
      uf(DISTRIBUTION_SP_FIELDS.status.postfix)]
  }
  if (start) params.start = start
  return { method: 'crm.item.list', params }
}

/** Build the `crm.item.list` for ALL distribution rows of one payment element (any status — active
 *  AND reverted, for the UI history), by parent link. `start` paginates. Same select as the active
 *  list (adds nothing status-specific). */
export function buildPaymentRowsListCall(
  distributionSp: SpRef,
  paymentSp: SpRef,
  paymentElementId: string,
  start?: number
): { method: string, params: Record<string, unknown> } {
  const uf = (postfix: string) => buildUfFieldNameCamel(distributionSp.id, postfix)
  const params: Record<string, unknown> = {
    entityTypeId: distributionSp.entityTypeId,
    filter: { [parentPaymentField(distributionSp)]: Number(paymentElementId) },
    select: ['id',
      uf(DISTRIBUTION_SP_FIELDS.amount.postfix),
      uf(DISTRIBUTION_SP_FIELDS.currency.postfix),
      uf(DISTRIBUTION_SP_FIELDS.targetKind.postfix),
      uf(DISTRIBUTION_SP_FIELDS.targetId.postfix),
      uf(DISTRIBUTION_SP_FIELDS.source.postfix),
      uf(DISTRIBUTION_SP_FIELDS.status.postfix)]
  }
  if (start) params.start = start
  return { method: 'crm.item.list', params }
}

/** Build the `crm.item.list` for ALL payment carrier elements of the portal (for the «Распределение»
 *  UI), newest first, paginated. Selects the total + currency + our UF state fields. */
export function buildPaymentListCall(paymentSp: SpRef, start?: number): { method: string, params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    entityTypeId: paymentSp.entityTypeId,
    order: { id: 'desc' },
    select: ['id', 'companyId',
      buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.total.postfix),
      buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.currency.postfix),
      buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.needDistributionsSum.postfix),
      buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.requiresRedistribution.postfix),
      buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.marker.postfix)]
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
export function parsePaymentCarrier(item: Record<string, unknown>, paymentSp: SpRef): PaymentCarrierHeader | null {
  const id = item.id
  if (id === undefined || id === null || `${id}` === '') return null
  const pf = (postfix: string) => item[buildUfFieldNameCamel(paymentSp.id, postfix)]
  const total = Number(pf(PAYMENT_SP_FIELDS.total.postfix))
  return {
    id: `${id}`,
    total: Number.isFinite(total) ? round2(total) : 0,
    currency: String(pf(PAYMENT_SP_FIELDS.currency.postfix) ?? ''),
    requiresRedistribution: String(pf(PAYMENT_SP_FIELDS.requiresRedistribution.postfix) ?? '') === 'Y'
  }
}

/** Parse one distribution ledger item (from `crm.item.list`) into a `DistributionEntry`. Reads our
 *  UF fields (by full name) + the built-in `opportunity`/`currencyId`. Non-finite amount → 0. */
export function parseLedgerRow(item: Record<string, unknown>, distributionSp: SpRef): DistributionEntry {
  const uf = (postfix: string) => item[buildUfFieldNameCamel(distributionSp.id, postfix)]
  const amount = Number(uf(DISTRIBUTION_SP_FIELDS.amount.postfix))
  return {
    targetKind: String(uf(DISTRIBUTION_SP_FIELDS.targetKind.postfix) ?? '') as AllocationTargetKind,
    targetId: String(uf(DISTRIBUTION_SP_FIELDS.targetId.postfix) ?? ''),
    amount: Number.isFinite(amount) ? round2(amount) : 0,
    currency: String(uf(DISTRIBUTION_SP_FIELDS.currency.postfix) ?? ''),
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
  paymentSp: SpRef,
  paymentElementId: string,
  remaining: number
): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: paymentSp.entityTypeId,
      id: Number(paymentElementId),
      fields: { [buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.needDistributionsSum.postfix)]: round2(remaining) }
    }
  }
}

/** Build the `crm.item.list` call for the ACTIVE distribution rows pointing at a given TARGET
 *  (`targetKind` + `targetId`) — the input to a target-deletion reconcile (§9.2: a deleted deal/
 *  invoice frees the distributions on it). Selects the parent link (so the caller knows which
 *  payment to recompute) + source (manual vs auto → §3). `start` paginates. */
export function buildTargetRowsListCall(
  distributionSp: SpRef,
  paymentSp: SpRef,
  targetKind: AllocationTargetKind,
  targetId: string,
  start?: number
): { method: string, params: Record<string, unknown> } {
  const uf = (postfix: string) => buildUfFieldNameCamel(distributionSp.id, postfix)
  const params: Record<string, unknown> = {
    entityTypeId: distributionSp.entityTypeId,
    filter: {
      [uf(DISTRIBUTION_SP_FIELDS.targetKind.postfix)]: targetKind,
      [uf(DISTRIBUTION_SP_FIELDS.targetId.postfix)]: targetId,
      [uf(DISTRIBUTION_SP_FIELDS.status.postfix)]: 'active'
    },
    select: ['id', parentPaymentField(distributionSp), uf(DISTRIBUTION_SP_FIELDS.source.postfix)]
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
export function parseTargetRow(item: Record<string, unknown>, distributionSp: SpRef, _paymentSp?: SpRef): TargetRowRef | null {
  const rowId = item.id
  const parent = item[parentPaymentField(distributionSp)]
  if (rowId === undefined || rowId === null || `${rowId}` === '') return null
  if (parent === undefined || parent === null || `${parent}` === '') return null
  const source = String(item[buildUfFieldNameCamel(distributionSp.id, DISTRIBUTION_SP_FIELDS.source.postfix)] ?? 'auto') === 'manual' ? 'manual' : 'auto'
  return { rowId: `${rowId}`, parentPaymentId: `${parent}`, source }
}

/** Build the `crm.item.update` that DEACTIVATES a distribution row (`status → reverted`, history kept
 *  — we never hard-delete, §9.2). */
export function buildDeactivateRowCall(distributionSp: SpRef, rowId: string): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: distributionSp.entityTypeId,
      id: Number(rowId),
      fields: { [buildUfFieldNameCamel(distributionSp.id, DISTRIBUTION_SP_FIELDS.status.postfix)]: 'reverted' }
    }
  }
}

/** Build the `crm.item.update` that sets «требует распределения» (Y/N) on a payment carrier element
 *  (§3: raised when a MANUAL distribution was freed by a target change/deletion). */
export function buildRequiresRedistributionCall(
  paymentSp: SpRef,
  paymentElementId: string,
  value: boolean
): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: paymentSp.entityTypeId,
      id: Number(paymentElementId),
      fields: { [buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.requiresRedistribution.postfix)]: value ? 'Y' : 'N' }
    }
  }
}

/** Build the `crm.item.list` that reads a payment carrier element by id — for its total + currency
 *  (our own UF fields, not the non-writable opportunity/currencyId), needed to recompute «осталось». */
export function buildPaymentReadCall(paymentSp: SpRef, paymentElementId: string): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: paymentSp.entityTypeId,
      filter: { id: Number(paymentElementId) },
      select: ['id',
        buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.total.postfix),
        buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.currency.postfix)]
    }
  }
}

/** Extract `{ total, currency }` from a payment-read list item (our own total/currency UF fields).
 *  Non-finite total → 0. */
export function parsePaymentTotal(item: Record<string, unknown> | undefined, paymentSp: SpRef): { total: number, currency: string } {
  const total = Number(item?.[buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.total.postfix)])
  const currency = String(item?.[buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.currency.postfix)] ?? '')
  return { total: Number.isFinite(total) ? round2(total) : 0, currency }
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
export function buildPaymentElementAddCall(paymentSp: SpRef, input: PaymentElementInput): { method: string, params: Record<string, unknown> } {
  const amount = round2(input.opportunity)
  const pf = (postfix: string) => buildUfFieldNameCamel(paymentSp.id, postfix)
  // total/currency in OUR own fields (opportunity/currencyId aren't writable on an SP); «осталось»
  // starts at the full amount (nothing distributed yet).
  const fields: Record<string, unknown> = {
    [pf(PAYMENT_SP_FIELDS.total.postfix)]: amount,
    [pf(PAYMENT_SP_FIELDS.currency.postfix)]: input.currency,
    [pf(PAYMENT_SP_FIELDS.needDistributionsSum.postfix)]: amount,
    [pf(PAYMENT_SP_FIELDS.marker.postfix)]: input.marker
  }
  // Link the payer company only when matched (a positive integer id).
  const companyId = Number(input.companyId)
  if (input.companyId && Number.isInteger(companyId) && companyId > 0) fields.companyId = companyId
  return {
    method: 'crm.item.add',
    params: { entityTypeId: paymentSp.entityTypeId, fields }
  }
}

/** Build the `crm.item.list` that finds a payment carrier element by its operation marker (idempotency
 *  probe — one carrier per operation). Selects id + our total + currency (for a later recompute). */
export function buildPaymentMarkerListCall(paymentSp: SpRef, marker: string): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: paymentSp.entityTypeId,
      filter: { [buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.marker.postfix)]: marker },
      select: ['id',
        buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.total.postfix),
        buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.currency.postfix)]
    }
  }
}
