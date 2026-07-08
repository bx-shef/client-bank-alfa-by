// Load the set of "negative" CRM stages for an entity, so invoiceLookup can drop
// invoices we must not allocate to (#109, PROCESSING.md §2). A stage is negative
// when its `crm.status` SEMANTICS is 'F' (fail) — confirmed live on a Smart Invoice
// (e.g. «Не оплачен» `DT31_11:D`). Pure over an injected `RestCall`, so it unit-tests
// without the network. The caller turns the loaded set into the `isNegativeStage`
// predicate that `findInvoicesByNumber` (invoiceLookup.ts) already accepts.

import type { RestCall } from './companyLookup'

/** `crm.status` top-level SEMANTICS marking a "fail"/negative stage. This field is
 *  flagged "deprecated" in the official docs, yet it is what the live portal fills
 *  (confirmed: «Не оплачен» `DT31_11:D` → `'F'`); the modern shape is
 *  `EXTRA.SEMANTICS = 'failure'`. We read BOTH so a portal on either shape works. */
export const NEGATIVE_SEMANTICS = 'F'
/** Modern (`EXTRA.SEMANTICS`) value for a fail/negative stage. */
export const NEGATIVE_SEMANTICS_EXTRA = 'failure'

/**
 * Stage-directory `ENTITY_ID` for a Smart Invoice category. Confirmed live:
 * `SMART_INVOICE_STAGE_<categoryId>` (default invoice category is 11), whose
 * statuses are `DT31_<categoryId>:<code>`. Deals use a DIFFERENT form — see
 * `dealStageEntityId` (confirmed live: `DEAL_STAGE` / `DEAL_STAGE_<catId>`, NOT the
 * `DYNAMIC_…` shape). Custom smart processes use `smartProcessStageEntityId`.
 */
export function invoiceStageEntityId(categoryId: number | string): string {
  return `SMART_INVOICE_STAGE_${categoryId}`
}

/**
 * Stage-directory `ENTITY_ID` for a DEAL category. Confirmed live: the default
 * pipeline (category 0) is plain `DEAL_STAGE`; every other pipeline is
 * `DEAL_STAGE_<categoryId>` (e.g. `DEAL_STAGE_5`). Negative deal stages are
 * `LOSE`/`APOLOGY` (`SEMANTICS='F'`) — same convention as invoices.
 */
export function dealStageEntityId(categoryId: number | string): string {
  return `${categoryId}` === '0' ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}`
}

/**
 * Stage-directory `ENTITY_ID` for a custom SMART PROCESS category. Confirmed live:
 * `DYNAMIC_<entityTypeId>_STAGE_<categoryId>` (statuses `DT<entityTypeId>_<categoryId>:<code>`,
 * negative stage `…:FAIL` with `SEMANTICS='F'`). Unlike deals, there is NO bare form
 * for the default pipeline — even a smart process «без направлений» has a real
 * default category id (its own, not `0`), so ALWAYS pass the actual `categoryId`
 * (from the item's `categoryId` / `crm.category.list`), never assume `0`.
 */
export function smartProcessStageEntityId(entityTypeId: number | string, categoryId: number | string): string {
  return `DYNAMIC_${entityTypeId}_STAGE_${categoryId}`
}

interface RawStatus {
  STATUS_ID?: unknown
  SEMANTICS?: unknown
  EXTRA?: { SEMANTICS?: unknown }
}

/** True if a status row is a fail/negative stage, on either the legacy top-level
 *  `SEMANTICS='F'` or the modern `EXTRA.SEMANTICS='failure'`. */
function isNegativeStatus(row: RawStatus): boolean {
  return row?.SEMANTICS === NEGATIVE_SEMANTICS || row?.EXTRA?.SEMANTICS === NEGATIVE_SEMANTICS_EXTRA
}

/** Pull the STATUS_IDs with a negative SEMANTICS out of a `crm.status.list`
 *  response (tolerant of a missing/!array result and rows without the fields). */
export function extractNegativeStageIds(resp: Record<string, unknown>): Set<string> {
  const rows = resp?.result
  const out = new Set<string>()
  if (!Array.isArray(rows)) return out
  for (const row of rows as RawStatus[]) {
    if (!isNegativeStatus(row)) continue
    const id = row.STATUS_ID
    if (id !== undefined && id !== null && `${id}` !== '') out.add(`${id}`)
  }
  return out
}

/**
 * Load the negative stage ids for a stage-directory `ENTITY_ID` via
 * `crm.status.list`. Returns a Set (empty if the entity has no negative stages).
 * A transport error from `call` propagates; there is no "not found" — an unknown
 * entity simply yields an empty set. No pagination: a status directory is a handful
 * of rows, well under B24's page size.
 *
 * CAVEAT (fail-open): an empty Set means "nothing is negative", which is
 * INDISTINGUISHABLE from a broken/misconfigured query (wrong ENTITY_ID, trimmed
 * rights). The crm-sync wiring that consumes this should ALERT when a category
 * known to have a negative stage (e.g. invoice category 11) yields an empty set,
 * rather than silently allocating onto a «Не оплачен» invoice.
 */
export async function loadNegativeStages(stageEntityId: string, call: RestCall): Promise<Set<string>> {
  const resp = await call('crm.status.list', {
    filter: { ENTITY_ID: stageEntityId },
    select: ['STATUS_ID', 'SEMANTICS', 'EXTRA']
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

/** Convenience: load the negative-stage predicate for a DEAL pipeline (category)
 *  in one call. Same fail-open caveat as `loadNegativeStages`. */
export async function loadDealNegativeStage(
  categoryId: number | string,
  call: RestCall
): Promise<(stageId: string) => boolean> {
  const negative = await loadNegativeStages(dealStageEntityId(categoryId), call)
  return makeIsNegativeStage(negative)
}

/** Convenience: load the negative-stage predicate for a custom SMART PROCESS
 *  category (`entityTypeId` + `categoryId`) in one call. Same fail-open caveat as
 *  `loadNegativeStages`. */
export async function loadSmartProcessNegativeStage(
  entityTypeId: number | string,
  categoryId: number | string,
  call: RestCall
): Promise<(stageId: string) => boolean> {
  const negative = await loadNegativeStages(smartProcessStageEntityId(entityTypeId, categoryId), call)
  return makeIsNegativeStage(negative)
}
