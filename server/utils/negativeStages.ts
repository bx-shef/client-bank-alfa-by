// Build ONE `isNegativeStage` predicate covering a whole portal's invoice AND deal
// stages (#109, PROCESSING.md §2), so the crm-sync allocation lookups drop candidates
// sitting in a paid/lost/failed stage. Pure over an injected `RestCall` (+ the
// `stageLoader` primitives) — unit-testable without the network.
//
// WHY A UNION. A candidate's category isn't known until it is queried, and the
// `isNegativeStage` predicate is applied INLINE inside each resolver (invoiceLookup /
// itemByIdLookup / paymentLookup) — it can't do REST per candidate. So we pre-load the
// negative stages of EVERY category of both entity types and union them into one set.
// This is safe because the stage-id namespaces do NOT collide:
//   • invoices → `DT31_<cat>:<code>` (e.g. «Не оплачен» `DT31_11:D`)
//   • deals    → `LOSE`/`APOLOGY` (default funnel) or `C<cat>:LOSE` (categorized)
// A `crm.item.list` candidate's `stageId` equals its `crm.status.list` `STATUS_ID`
// (confirmed live), so one combined set matches every candidate's `stageId` directly —
// invoices, deals, and the deal-payment company pool (which filters deals by stage).
//
// COST is a handful of REST calls per portal (`crm.category.list` ×2 + `crm.status.list`
// per category), so the caller loads this ONCE PER JOB (lazily) and reuses the predicate
// for every operation — not once per op. See docs/QUEUES.md «REST-бюджет проводки».

import type { RestCall } from './companyLookup'
import {
  DEAL_ENTITY_TYPE_ID
} from './paymentLookup'
import { SMART_INVOICE_ENTITY_TYPE_ID } from './invoiceLookup'
import {
  dealStageEntityId, invoiceStageEntityId, loadNegativeStages, makeIsNegativeStage
} from './stageLoader'

/** Per-entity-type diagnostics for the fail-open alert: how many funnels the entity
 *  type has and how many negative stages were found across them. `categories > 0 &&
 *  negativeStages === 0` is the tell-tale of a broken query / trimmed rights (a real
 *  portal's deal funnel always has at least one LOSE stage) — the caller should ALERT
 *  rather than silently exclude nothing (docs/PROCESSING.md §5, stageLoader fail-open). */
export interface EntityStageDiagnostics {
  categories: number
  negativeStages: number
}

export interface NegativeStageDiagnostics {
  invoice: EntityStageDiagnostics
  deal: EntityStageDiagnostics
}

export interface PortalNegativeStages {
  /** True for a stage id we must NOT allocate to (union of invoice + deal negatives). */
  predicate: (stageId: string) => boolean
  diagnostics: NegativeStageDiagnostics
}

/** Strip a leading `C<digits>:` deal category prefix (`C5:LOSE` → `LOSE`). Deal stage
 *  ids come categorized (`C<cat>:CODE`) or bare (`CODE`) depending on the funnel, and the
 *  `crm.status.list` negative set may hold either form. The CATEGORIZED form (`C5:LOSE`)
 *  is live-confirmed; the DEFAULT-funnel form that `crm.item.list` returns is NOT yet
 *  live-verified (could be bare `LOSE` or `C0:LOSE`). Matching BOTH the raw id and its
 *  stripped code makes the negative check robust to whichever form comes back. This is
 *  false-negative-SAFE: `LOSE`/`APOLOGY` are semantically fixed across funnels, so a strip
 *  only ever ADDS a match against a bare negative code — it can never drop a valid
 *  (allocatable) candidate. Non-deal ids (invoice `DT31_…`) don't match the prefix and
 *  pass through unchanged. Live-verify the default-funnel form before allocation is
 *  WRITTEN off these candidates (currently log/count only). */
export function stripDealCategoryPrefix(stageId: string): string {
  return stageId.replace(/^C\d+:/, '')
}

/** Entity types whose negative-stage load looks BROKEN (fail-open): the entity has
 *  funnels but ZERO negative stages were found. A real portal's funnel almost always has
 *  at least one fail/lost stage (invoice «Не оплачен», deal `LOSE`), so this is the
 *  tell-tale of a trimmed-rights / bad-`ENTITY_ID` query — the caller ALERTS rather than
 *  silently allocating onto a paid/lost entity (docs/PROCESSING.md §5, stageLoader
 *  fail-open caveat). Symmetric across invoice AND deal (both are live allocation targets). */
export function failOpenEntities(diagnostics: NegativeStageDiagnostics): string[] {
  const out: string[] = []
  if (diagnostics.invoice.categories > 0 && diagnostics.invoice.negativeStages === 0) out.push('invoice')
  if (diagnostics.deal.categories > 0 && diagnostics.deal.negativeStages === 0) out.push('deal')
  return out
}

interface RawCategory {
  id?: unknown
}

/** Pull the category ids out of a `crm.category.list` response (`result.categories[]`).
 *  Tolerant of a missing/!array result and rows without an id. Ids are normalized to
 *  strings (the default funnel id is `0`, which is valid — kept, not dropped). */
export function extractCategoryIds(resp: Record<string, unknown>): string[] {
  const cats = (resp?.result as Record<string, unknown> | undefined)?.categories
  if (!Array.isArray(cats)) return []
  const out: string[] = []
  for (const row of cats as RawCategory[]) {
    const id = row?.id
    if (id === undefined || id === null) continue
    out.push(String(id))
  }
  return out
}

/** Hard cap on `crm.category.list` pages (50 rows each) — a DoS/runaway backstop far
 *  above any real portal's funnel count (40×50 = 2000 categories per entity type). */
const MAX_CATEGORY_PAGES = 40

/** List a CRM entity type's funnel (category) ids via `crm.category.list`. A transport
 *  error propagates; an unsupported entity type would surface as that error, not silently.
 *  The method is SINGLE-PAGE (max 50 rows) and reports `total` — so a portal with >50
 *  funnels is paged via `start`, else the overflow categories (and their negative stages)
 *  would be silently dropped (fail-open). Bounded by `total` and `MAX_CATEGORY_PAGES`. */
export async function loadCategoryIds(entityTypeId: number, call: RestCall): Promise<string[]> {
  const out: string[] = []
  let start = 0
  for (let page = 0; page < MAX_CATEGORY_PAGES; page++) {
    const resp = await call('crm.category.list', { entityTypeId, start })
    const ids = extractCategoryIds(resp)
    out.push(...ids)
    const total = Number(resp?.total)
    // Stop when an empty page came back or we've collected everything `total` promised.
    if (ids.length === 0 || !Number.isFinite(total) || out.length >= total) break
    start += ids.length
  }
  return out
}

/**
 * Union the negative stages of EVERY category of one entity type into a single set.
 * `stageEntityIdFor(categoryId)` maps a category to its `crm.status` `ENTITY_ID`
 * (e.g. `invoiceStageEntityId` / `dealStageEntityId`). Returns the union set + the
 * category count (for diagnostics). A transport error propagates.
 */
export async function loadEntityNegativeStages(
  entityTypeId: number,
  stageEntityIdFor: (categoryId: string) => string,
  call: RestCall
): Promise<{ negative: Set<string>, categories: number }> {
  const categoryIds = await loadCategoryIds(entityTypeId, call)
  const negative = new Set<string>()
  for (const categoryId of categoryIds) {
    const set = await loadNegativeStages(stageEntityIdFor(categoryId), call)
    for (const id of set) negative.add(id)
  }
  return { negative, categories: categoryIds.length }
}

/**
 * Build the portal-wide negative-stage predicate (invoices + deals) and diagnostics.
 * Loaded once per crm-sync job by the caller (lazily) and reused for every operation.
 * A transport error from any underlying call propagates (fail the job → clean retry).
 *
 * Smart processes are NOT included: their `entityTypeId` is portal-specific (from the
 * mapping config) and their intents are still `unsupported` in the resolver — add them
 * here when that slice lands (`smartProcessStageEntityId`).
 */
export async function buildPortalNegativeStagePredicate(call: RestCall): Promise<PortalNegativeStages> {
  const invoice = await loadEntityNegativeStages(SMART_INVOICE_ENTITY_TYPE_ID, invoiceStageEntityId, call)
  const deal = await loadEntityNegativeStages(DEAL_ENTITY_TYPE_ID, dealStageEntityId, call)
  const union = new Set<string>([...invoice.negative, ...deal.negative])
  const isNeg = makeIsNegativeStage(union)
  return {
    // Match the raw stage id OR its deal-category-stripped code (see stripDealCategoryPrefix)
    // so a default-funnel lost deal is caught whichever id form crm.item.list returns.
    predicate: (stageId: string) => isNeg(stageId) || isNeg(stripDealCategoryPrefix(stageId)),
    diagnostics: {
      invoice: { categories: invoice.categories, negativeStages: invoice.negative.size },
      deal: { categories: deal.categories, negativeStages: deal.negative.size }
    }
  }
}
