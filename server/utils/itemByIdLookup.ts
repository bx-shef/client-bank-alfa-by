// Resolve an allocation target by its own CRM id (#109, PROCESSING.md §2/§4). The
// id comes from the payment purpose and is therefore UNTRUSTED — so the lookup
// filters by `companyId` in the query (IDOR: only the resolved counterparty's own
// entity comes back, never an arbitrary one whose id a payer guessed) and drops
// negative-stage entities.
//
// Covers the `by-id` strategy of identifierDispatch (`invoice-id`→invoice,
// `deal-id`→deal, `smart-id`→smart-process): all three are the same `crm.item.list`
// object, differing only by `entityTypeId`. NOT for `order-id`/`payment-id` — those
// resolve to a `deal-payment` (a `crm.item.payment.*` object) via the company pool:
// `payment-id` by the payment's own id, `order-id` by `sale.payment.list` (orderId→payment
// ids) intersected with the pool (`saleLookup` + `filterByPaymentIds`, `sale` scope, #172).
//
// Uses `crm.item.list` (not `crm.item.get`): a list returns an empty array for a
// missing/foreign id, whereas `crm.item.get` throws NOT_FOUND — the list shape lets
// "not found" read as `null` without catching, matching invoiceLookup. Pure over an
// injected `RestCall`. Field names confirmed live (`companyId`/`stageId`/
// `opportunity`/`currencyId`; a categorized deal's `stageId` carries the `C<cat>:`
// prefix, e.g. `C5:LOSE`, which matches the `DEAL_STAGE_<cat>` status ids).

import { isAmountTarget, type AllocationCandidate, type AllocationTargetKind } from '../../app/utils/allocation'
import { parentDealId } from './invoiceLookup'
import { DEAL_ENTITY_TYPE_ID } from './paymentLookup'
import type { RestCall } from './companyLookup'

/** Fields to select for a by-id/by-field lookup. `parentId2` (the linked DEAL, #229) is
 *  meaningful for an INVOICE (its deal link) and a smart process (its parent deal), but for
 *  a DEAL itself (entityTypeId 2) `parentId2` means "parent of entity type 2" = a parent
 *  DEAL — a self-reference Bitrix REJECTS live ("An entity type can't be a parent/child
 *  type to itself"). So it is selected for every entity type EXCEPT a deal (where it is a
 *  self-reference AND unused — only an invoice candidate reads `dealId`). */
function selectFields(entityTypeId: number): string[] {
  const base = ['id', 'companyId', 'stageId', 'opportunity', 'currencyId']
  return entityTypeId === DEAL_ENTITY_TYPE_ID ? base : [...base, 'parentId2']
}

export interface ItemByIdOptions {
  /** The counterparty company already resolved from the account — IDOR scope. The
   *  entity must belong to it, else the id is treated as no match. */
  companyId: string
  /** True for a stage we must NOT allocate to (built by stageLoader). Omitted →
   *  keep every stage. */
  isNegativeStage?: (stageId: string) => boolean
}

/** `crm.item.list` params to fetch one entity by id WITHIN one company. Filtering
 *  by `companyId` in the query (not post-hoc) is the IDOR guard. */
export function itemByIdParams(entityTypeId: number, id: string, companyId: string): Record<string, unknown> {
  return {
    entityTypeId,
    filter: { id, companyId },
    select: selectFields(entityTypeId)
  }
}

interface RawItem {
  id?: unknown
  stageId?: unknown
  opportunity?: unknown
  currencyId?: unknown
  parentId2?: unknown
}

/** Pull the single item out of a `crm.item.list` response (`result.items[0]`). */
export function firstItem(resp: Record<string, unknown>): RawItem | undefined {
  const items = (resp?.result as Record<string, unknown> | undefined)?.items
  return Array.isArray(items) ? (items[0] as RawItem | undefined) : undefined
}

/**
 * Find one allocation candidate by its CRM id, scoped to `opts.companyId` and
 * excluding negative-stage entities. Returns `null` when the id doesn't exist,
 * belongs to another company, or sits in a negative stage. A transport error from
 * `call` propagates. `amount`/`currency` come from `opportunity`/`currencyId` (used
 * only for the amount-gated kinds `invoice`/`deal-payment`; the trigger kinds
 * `deal`/`smart-process` ignore them). For an amount-gated kind a non-finite
 * amount yields `null` (can't be matched by amount — same fail-closed rule as
 * `invoiceLookup`); for a trigger kind it normalizes to 0.
 */
export async function findCandidateById(
  kind: AllocationTargetKind,
  entityTypeId: number,
  id: string,
  opts: ItemByIdOptions,
  call: RestCall
): Promise<AllocationCandidate | null> {
  const cleanId = String(id).trim()
  if (!cleanId) return null
  if (!opts.companyId.trim()) return null

  const resp = await call('crm.item.list', itemByIdParams(entityTypeId, cleanId, opts.companyId))
  return candidateFromItem(kind, entityTypeId, firstItem(resp), opts)
}

/** A CRM field name valid to use as a `crm.item.list` filter key: a standard field or a
 *  user field (`UF_CRM_*`). Anchored to letters/digits/underscore so an admin-configured
 *  value can never inject an operator prefix (`>`, `%`, `!`) into the filter. */
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/

/** `crm.item.list` params to fetch one entity whose configured FIELD equals `value`,
 *  WITHIN one company (the IDOR guard, same as `itemByIdParams`). */
export function itemByFieldParams(entityTypeId: number, fieldName: string, value: string, companyId: string): Record<string, unknown> {
  return {
    entityTypeId,
    filter: { [fieldName]: value, companyId },
    select: selectFields(entityTypeId)
  }
}

/**
 * Find one allocation candidate whose CONFIGURED CRM field (`fieldName`, from the portal's
 * «карта сопоставления») equals the recognized `value`, scoped to `opts.companyId` and
 * excluding negative stages (the `by-config-field` strategy, `deal-field`/`smart-field`, §4).
 * Returns `null` when the field name is malformed, the value is empty, nothing matches, or the
 * match sits in a negative stage. Mirrors `findCandidateById`, differing only in the filter key.
 * A transport error from `call` propagates. The value comes from the payer-controlled purpose,
 * so the query filters by `companyId` too — IDOR: only THIS company's entity can come back.
 */
export async function findCandidateByField(
  kind: AllocationTargetKind,
  entityTypeId: number,
  fieldName: string,
  value: string,
  opts: ItemByIdOptions,
  call: RestCall
): Promise<AllocationCandidate | null> {
  const cleanField = String(fieldName).trim()
  const cleanValue = String(value).trim()
  if (!cleanField || !FIELD_NAME_RE.test(cleanField)) return null // malformed config field → no lookup
  if (!cleanValue) return null
  if (!opts.companyId.trim()) return null

  const resp = await call('crm.item.list', itemByFieldParams(entityTypeId, cleanField, cleanValue, opts.companyId))
  return candidateFromItem(kind, entityTypeId, firstItem(resp), opts)
}

/** Map a fetched `crm.item.list` row to an `AllocationCandidate`, applying the shared
 *  negative-stage drop, amount fail-closed (amount kinds), invoice `dealId` (#229) and
 *  smart-process `entityTypeId` (#79) rules. `null` item / empty id / negative stage → null. */
function candidateFromItem(
  kind: AllocationTargetKind,
  entityTypeId: number,
  item: RawItem | undefined,
  opts: ItemByIdOptions
): AllocationCandidate | null {
  if (!item) return null

  const stageId = item.stageId === undefined || item.stageId === null ? '' : String(item.stageId)
  if (opts.isNegativeStage?.(stageId)) return null

  const outId = item.id === undefined || item.id === null ? '' : String(item.id)
  if (!outId) return null
  const amount = Number(item.opportunity)
  const finite = Number.isFinite(amount)
  if (!finite && isAmountTarget(kind)) return null
  // Only an invoice carries a self→deal link (`parentId2`, #229) — lets `collapseSameTarget`
  // merge an `invoice-id` target with the same deal's payment. Other kinds: no dealId.
  const dealId = kind === 'invoice' ? parentDealId(item.parentId2) : undefined
  return {
    kind,
    id: outId,
    amount: finite ? amount : 0,
    currency: String(item.currencyId ?? ''),
    ...(dealId ? { dealId } : {}),
    // A smart-process trigger needs its entityTypeId as OWNER_TYPE_ID (#79); the caller
    // passes it in, so thread it back onto the candidate. Deal uses the fixed OWNER_TYPE_ID=2.
    ...(kind === 'smart-process' ? { entityTypeId } : {})
  }
}
