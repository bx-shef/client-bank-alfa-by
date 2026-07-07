// Resolve an allocation target by its own CRM id (#109, PROCESSING.md §2/§4). The
// id comes from the payment purpose and is therefore UNTRUSTED — so the lookup
// filters by `companyId` in the query (IDOR: only the resolved counterparty's own
// entity comes back, never an arbitrary one whose id a payer guessed) and drops
// negative-stage entities.
//
// Covers the `by-id` strategy of identifierDispatch (`invoice-id`→invoice,
// `deal-id`→deal, `smart-id`→smart-process): all three are the same `crm.item.list`
// object, differing only by `entityTypeId`. NOT for `order-id`/`payment-id` — those
// route `via-order`/`via-payment` to a `deal-payment` (a `crm.item.payment.*`
// object, different method/shape), resolved by a separate module.
//
// Uses `crm.item.list` (not `crm.item.get`): a list returns an empty array for a
// missing/foreign id, whereas `crm.item.get` throws NOT_FOUND — the list shape lets
// "not found" read as `null` without catching, matching invoiceLookup. Pure over an
// injected `RestCall`. Field names confirmed live (`companyId`/`stageId`/
// `opportunity`/`currencyId`; a categorized deal's `stageId` carries the `C<cat>:`
// prefix, e.g. `C5:LOSE`, which matches the `DEAL_STAGE_<cat>` status ids).

import type { AllocationCandidate, AllocationTargetKind } from '../../app/utils/allocation'
import type { RestCall } from './companyLookup'

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
    select: ['id', 'companyId', 'stageId', 'opportunity', 'currencyId']
  }
}

interface RawItem {
  id?: unknown
  stageId?: unknown
  opportunity?: unknown
  currencyId?: unknown
}

/** Pull the single item out of a `crm.item.list` response (`result.items[0]`). */
export function firstItem(resp: Record<string, unknown>): RawItem | undefined {
  const items = (resp?.result as Record<string, unknown> | undefined)?.items
  return Array.isArray(items) ? (items[0] as RawItem | undefined) : undefined
}

/** Kinds matched by amount+currency (an unparseable amount can't match → no
 *  candidate). The trigger kinds (`deal`/`smart-process`) ignore amount, so a
 *  non-finite one is harmless there and normalizes to 0. */
const AMOUNT_GATED_KINDS = new Set<AllocationTargetKind>(['invoice', 'deal-payment'])

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
  const item = firstItem(resp)
  if (!item) return null

  const stageId = item.stageId === undefined || item.stageId === null ? '' : String(item.stageId)
  if (opts.isNegativeStage?.(stageId)) return null

  const outId = item.id === undefined || item.id === null ? '' : String(item.id)
  if (!outId) return null
  const amount = Number(item.opportunity)
  const finite = Number.isFinite(amount)
  if (!finite && AMOUNT_GATED_KINDS.has(kind)) return null
  return {
    kind,
    id: outId,
    amount: finite ? amount : 0,
    currency: String(item.currencyId ?? '')
  }
}
