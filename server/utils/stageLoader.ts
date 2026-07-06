// Load the set of "negative" CRM stages for an entity, so invoiceLookup can drop
// invoices we must not allocate to (#109, PROCESSING.md §2). A stage is negative
// when its `crm.status` SEMANTICS is 'F' (fail) — confirmed live on a Smart Invoice
// (e.g. «Не оплачен» `DT31_11:D`). Pure over an injected `RestCall`, so it unit-tests
// without the network. The caller turns the loaded set into the `isNegativeStage`
// predicate that `findInvoicesByNumber` (invoiceLookup.ts) already accepts.

import type { RestCall } from './companyLookup'

/** `crm.status` SEMANTICS marking a "fail"/negative stage (won't allocate to it). */
export const NEGATIVE_SEMANTICS = 'F'

/**
 * Stage-directory `ENTITY_ID` for a Smart Invoice category. Confirmed live:
 * `SMART_INVOICE_STAGE_<categoryId>` (default invoice category is 11), whose
 * statuses are `DT31_<categoryId>:<code>`. NB: general smart processes use
 * `DYNAMIC_<entityTypeId>_STAGE_<categoryId>` — invoices are the special-cased one.
 */
export function invoiceStageEntityId(categoryId: number | string): string {
  return `SMART_INVOICE_STAGE_${categoryId}`
}

interface RawStatus {
  STATUS_ID?: unknown
  SEMANTICS?: unknown
}

/** Pull the STATUS_IDs with a negative SEMANTICS out of a `crm.status.list`
 *  response (tolerant of a missing/!array result and rows without the fields). */
export function extractNegativeStageIds(resp: Record<string, unknown>): Set<string> {
  const rows = resp?.result
  const out = new Set<string>()
  if (!Array.isArray(rows)) return out
  for (const row of rows as RawStatus[]) {
    if (row?.SEMANTICS !== NEGATIVE_SEMANTICS) continue
    const id = row.STATUS_ID
    if (id !== undefined && id !== null && `${id}` !== '') out.add(`${id}`)
  }
  return out
}

/**
 * Load the negative stage ids for a stage-directory `ENTITY_ID` via
 * `crm.status.list`. Returns a Set (empty if the entity has no negative stages).
 * A transport error from `call` propagates; there is no "not found" — an unknown
 * entity simply yields an empty set.
 */
export async function loadNegativeStages(stageEntityId: string, call: RestCall): Promise<Set<string>> {
  const resp = await call('crm.status.list', {
    filter: { ENTITY_ID: stageEntityId },
    select: ['STATUS_ID', 'SEMANTICS']
  })
  return extractNegativeStageIds(resp)
}

/**
 * Build the `isNegativeStage` predicate that `findInvoicesByNumber` accepts. An
 * empty set → a predicate that keeps every stage (nothing is negative). A blank
 * `stageId` is never negative.
 */
export function makeIsNegativeStage(negative: Set<string>): (stageId: string) => boolean {
  return stageId => stageId !== '' && negative.has(stageId)
}

/** Convenience: load the negative-stage predicate for a Smart Invoice category in
 *  one call (loader + predicate builder). */
export async function loadInvoiceNegativeStage(
  categoryId: number | string,
  call: RestCall
): Promise<(stageId: string) => boolean> {
  const negative = await loadNegativeStages(invoiceStageEntityId(categoryId), call)
  return makeIsNegativeStage(negative)
}
