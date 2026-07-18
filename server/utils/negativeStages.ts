// Build ONE `isNegativeStage` predicate covering a whole portal's invoice AND deal
// stages (#109, PROCESSING.md §2), so the crm-sync allocation lookups drop candidates
// sitting in a lost/failed stage — AND a SETTLED (paid) invoice, which must not re-match
// a second same-amount payment (the negative filter alone let a paid invoice back in;
// mirrors paymentLookup's `paid:'Y'` drop). Pure over an injected `RestCall` (+ the
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

import type { RestBatch, RestCall } from './companyLookup'
import {
  DEAL_ENTITY_TYPE_ID
} from './paymentLookup'
import { SMART_INVOICE_ENTITY_TYPE_ID } from './invoiceLookup'
import {
  dealStageEntityId, invoiceStageEntityId, loadStageExclusions,
  makeIsNegativeStage, parseStageExclusions, smartProcessStageEntityId, stageStatusListParams
} from './stageLoader'

/** Per-entity-type diagnostics for the fail-open alert: how many funnels the entity
 *  type has, how many negative stages were found across them, and how many INDIVIDUAL
 *  funnels came back with ZERO negatives. `categories > 0 && negativeStages === 0` is the
 *  tell-tale of a broken query / trimmed rights (a real portal's deal funnel always has at
 *  least one LOSE stage). But the aggregate `negativeStages` alone is TOO COARSE: with
 *  several funnels, one trimmed/negative-less funnel is masked by the others' negatives
 *  (#242 review). `emptyCategories` counts per-funnel empties so a SINGLE broken funnel
 *  still trips the alert — the caller should ALERT rather than silently excluding nothing
 *  (docs/PROCESSING.md §5, stageLoader fail-open). */
export interface EntityStageDiagnostics {
  categories: number
  negativeStages: number
  /** Number of enumerated funnels that returned ZERO negative stages (per-funnel
   *  fail-open signal; a real funnel always has a LOSE/«Не оплачен» stage). */
  emptyCategories: number
}

export interface NegativeStageDiagnostics {
  invoice: EntityStageDiagnostics
  deal: EntityStageDiagnostics
  /** Present ONLY when a smart-process entityTypeId was configured for the portal (from
   *  `configFields['smart-entity']`). Absent ⇒ SP not configured ⇒ its FAIL stages are not
   *  loaded (and an SP candidate isn't stage-excluded — the same fail-open posture as before). */
  smartProcess?: EntityStageDiagnostics
}

export interface PortalNegativeStages {
  /** True for a stage id we must NOT allocate to: invoice negatives (lost/unpaid) +
   *  invoice SETTLED (paid) + deal negatives (lost). */
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

/** Entity types whose negative-stage load looks BROKEN (fail-open): the aggregate had ZERO
 *  negative stages, OR at least one enumerated funnel came back empty. A real portal ALWAYS
 *  has a fail/lost stage per funnel (invoice «Не оплачен» `DT31_…:D`, deal `LOSE`), so either
 *  shape is the tell-tale of trimmed rights / a bad `ENTITY_ID` query — INCLUDING the
 *  `categories === 0` case (`crm.category.list` returned nothing → `emptyCategories` stays 0
 *  but so does `negativeStages`, still flagged). The PER-FUNNEL `emptyCategories` check catches
 *  the case the aggregate misses: a portal with several funnels where ONE is trimmed — its
 *  lost deals would otherwise slip past the predicate while the alert stayed silent (#242).
 *  The caller must ALERT rather than silently allocating (and, with autoDistribute, PAYING) a
 *  lost/paid entity (docs/PROCESSING.md §5). Symmetric across invoice AND deal. */
export function failOpenEntities(diagnostics: NegativeStageDiagnostics): string[] {
  const out: string[] = []
  const broken = (d: EntityStageDiagnostics): boolean => d.negativeStages === 0 || d.emptyCategories > 0
  if (broken(diagnostics.invoice)) out.push('invoice')
  if (broken(diagnostics.deal)) out.push('deal')
  // Smart process only participates when configured (diagnostics.smartProcess present);
  // absent ⇒ not loaded ⇒ nothing to flag (SP candidates simply aren't stage-excluded).
  if (diagnostics.smartProcess && broken(diagnostics.smartProcess)) out.push('smart-process')
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
  call: RestCall,
  opts: { includeSettled?: boolean } = {},
  batch?: RestBatch | null
): Promise<{ negative: Set<string>, settled: Set<string>, categories: number, emptyCategories: number }> {
  const categoryIds = await loadCategoryIds(entityTypeId, call)
  const negative = new Set<string>()
  const settled = new Set<string>()
  const entityIds = categoryIds.map(stageEntityIdFor)
  // BATCHED (#191): every category's `crm.status.list` is independent, so fan them out in ONE
  // request instead of N sequential calls. Halt-on-error in the batch keeps the fail-open
  // contract (a failed status.list throws → job retries, never a silently-shrunk negative set).
  // Falls back to a SEQUENTIAL path (rate-safe by construction) when no batch transport is
  // provided (tests / non-SDK callers).
  const sets: Array<{ negative: Set<string>, settled: Set<string> }> = []
  if (batch && entityIds.length > 0) {
    const resps = await batch(entityIds.map(e => ({ method: 'crm.status.list', params: stageStatusListParams(e) })))
    for (const resp of resps) sets.push(parseStageExclusions(resp, opts))
  } else {
    for (const e of entityIds) sets.push(await loadStageExclusions(e, call, opts))
  }
  // Count per-funnel empties for the granular fail-open signal (#242): a funnel that returned
  // ZERO negatives is suspect on its own, even when OTHER funnels of the type have negatives.
  let emptyCategories = 0
  for (const s of sets) {
    if (s.negative.size === 0) emptyCategories++
    for (const id of s.negative) negative.add(id)
    for (const id of s.settled) settled.add(id)
  }
  return { negative, settled, categories: categoryIds.length, emptyCategories }
}

/**
 * Build the portal-wide negative-stage predicate (invoices + deals — and a custom SMART
 * PROCESS when its entityTypeId is configured) and diagnostics. Loaded once per crm-sync
 * job by the caller (lazily) and reused for every operation. A transport error from any
 * underlying call propagates (fail the job → clean retry).
 *
 * `smartEntityTypeId` comes from the portal's mapping config (`configFields['smart-entity']`,
 * parsed via `parseConfiguredEntityTypeId`) — the same value the resolver uses to dispatch
 * `smart-id`/`smart-field` intents. When present, the SP's FAIL stages
 * (`DYNAMIC_<etid>_STAGE_<cat>` → `DT<etid>_<cat>:FAIL`, `SEMANTICS='F'`, live-confirmed)
 * are loaded and unioned in, so a lost SP element stops being an allocation candidate.
 * When absent (SP not configured), behaviour is exactly as before (SP not stage-excluded).
 * SP stage ids carry their own `DT<etid>_…` namespace, disjoint from invoice `DT31_…` and
 * deal `LOSE`/`C<cat>:LOSE`, so the combined set stays unambiguous.
 */
export async function buildPortalNegativeStagePredicate(call: RestCall, batch?: RestBatch | null, smartEntityTypeId?: number | null): Promise<PortalNegativeStages> {
  // Invoices ALSO exclude SETTLED (paid/success) stages: a paid invoice must never
  // re-match a second same-amount payment (mirrors paymentLookup's `paid:'Y'` drop).
  // Deals load negatives only — a WON deal is namespaced differently (`WON`, no `DT31_…`),
  // and a deal's settledness is handled at the payment level (`paid:'Y'`), not the stage.
  // `batch` (when provided) collapses each entity type's per-funnel `crm.status.list` fan-out
  // into ONE request (#191); without it, the sequential path runs (unchanged).
  const invoice = await loadEntityNegativeStages(SMART_INVOICE_ENTITY_TYPE_ID, invoiceStageEntityId, call, { includeSettled: true }, batch)
  const deal = await loadEntityNegativeStages(DEAL_ENTITY_TYPE_ID, dealStageEntityId, call, {}, batch)
  // Smart process is optional — only loaded when the portal configured its entityTypeId.
  // Load negatives only (like deals): SP settledness on the amount path is handled by the
  // payment, and SP targets are trigger-fired, not amount-gated.
  // GUARD: a `smart-entity` misconfigured to the invoice (31) or deal (2) type would query a
  // bogus `DYNAMIC_<31|2>_STAGE_…` directory (empty ⇒ a spurious fail-open alert) while those
  // entities are already covered above — treat it as «not configured for SP» instead.
  const spConfigured = smartEntityTypeId
    && smartEntityTypeId !== SMART_INVOICE_ENTITY_TYPE_ID
    && smartEntityTypeId !== DEAL_ENTITY_TYPE_ID
  const sp = spConfigured
    ? await loadEntityNegativeStages(smartEntityTypeId as number, cat => smartProcessStageEntityId(smartEntityTypeId as number, cat), call, {}, batch)
    : null
  // Stage-id namespaces don't collide, so unioning the settled-invoice stages into the
  // single "do-not-allocate" set only ever drops paid INVOICES — never a deal candidate.
  const union = new Set<string>([...invoice.negative, ...invoice.settled, ...deal.negative, ...(sp?.negative ?? [])])
  const isNeg = makeIsNegativeStage(union)
  return {
    // Match the raw stage id OR its deal-category-stripped code (see stripDealCategoryPrefix)
    // so a default-funnel lost deal is caught whichever id form crm.item.list returns.
    predicate: (stageId: string) => isNeg(stageId) || isNeg(stripDealCategoryPrefix(stageId)),
    diagnostics: {
      invoice: { categories: invoice.categories, negativeStages: invoice.negative.size, emptyCategories: invoice.emptyCategories },
      deal: { categories: deal.categories, negativeStages: deal.negative.size, emptyCategories: deal.emptyCategories },
      ...(sp ? { smartProcess: { categories: sp.categories, negativeStages: sp.negative.size, emptyCategories: sp.emptyCategories } } : {})
    }
  }
}
