// Transport for the distribution SP-ledger (#109, PROCESSING.md §9.1/§9.3): write a distribution
// row (idempotent by marker), load a payment's active rows, and recompute its «осталось распределить».
// DI over the injected `RestCall` — unit-testable with a fake. All wire shapes come from the shared,
// tested builders in app/utils/distributionLedger.ts; this module only does REST + result extraction
// + pagination. NOT wired into crm-sync yet (the hot-path connection is the next slice).

import type { DistributionEntry } from '../../app/utils/manualAllocation'
import {
  buildActiveRowsListCall,
  buildDistributionRowAddCall,
  buildMarkerListCall,
  buildNeedRecomputeCall,
  computeNeedDistribution,
  parseLedgerRow,
  type DistributionRowInput
} from '../../app/utils/distributionLedger'
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
export async function findDistributionByMarker(distributionSpEtid: number, marker: string, call: RestCall): Promise<string | null> {
  if (!marker) return null
  const listCall = buildMarkerListCall(distributionSpEtid, marker)
  const resp = await call(listCall.method, listCall.params)
  const first = extractListItems(resp)[0]
  const id = first?.id
  return id !== undefined && id !== null && `${id}` !== '' ? `${id}` : null
}

/** Write one distribution row idempotently: if a row with the same marker already exists, return it
 *  (`created:false`) without adding a duplicate; else `crm.item.add` and return the new id. */
export async function writeDistributionRow(input: DistributionRowInput, call: RestCall): Promise<{ id: string, created: boolean }> {
  const existing = await findDistributionByMarker(input.distributionSpEtid, input.marker, call)
  if (existing) return { id: existing, created: false }
  const addCall = buildDistributionRowAddCall(input)
  const resp = await call(addCall.method, addCall.params)
  const id = extractAddedItemId(resp)
  if (!id) throw new Error('crm.item.add returned no distribution row id')
  return { id, created: true }
}

/** Load ALL active distribution rows of a payment element (paginated), parsed to entries. */
export async function loadActiveDistributions(
  distributionSpEtid: number,
  paymentSpEtid: number,
  paymentElementId: string,
  call: RestCall
): Promise<DistributionEntry[]> {
  const rows: DistributionEntry[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_LEDGER_PAGES && start !== null; page++) {
    const listCall = buildActiveRowsListCall(distributionSpEtid, paymentSpEtid, paymentElementId, start || undefined)
    const resp = await call(listCall.method, listCall.params)
    for (const item of extractListItems(resp)) rows.push(parseLedgerRow(item, distributionSpEtid))
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
  paymentSpEtid: number,
  paymentElementId: string,
  distributionSpEtid: number,
  total: number,
  currency: string,
  call: RestCall
): Promise<number> {
  const rows = await loadActiveDistributions(distributionSpEtid, paymentSpEtid, paymentElementId, call)
  const remaining = computeNeedDistribution(total, currency, rows)
  const updateCall = buildNeedRecomputeCall(paymentSpEtid, paymentElementId, remaining)
  await call(updateCall.method, updateCall.params)
  return remaining
}
