// Pure dispatch from a recognized intent (§4) to allocation candidates (#109,
// PROCESSING.md §2). Given ONE recognized identifier + the already-resolved payer
// company (IDOR scope) + a negative-stage predicate, call the matching entity
// resolver and return `AllocationCandidate[]`. The resolvers are injected so the
// routing decision unit-tests without the network; the concrete REST wiring (and the
// company resolution / stage loading that produce the context) is the worker slice.
//
// Only the strategies confirmed live are dispatched today; the rest return
// `unsupported` with a reason (portal-specific entityTypeId/field or a live-verify
// gate), so the caller can log coverage without silently dropping the intent.
//
// `resolveIntentCandidates` handles ONE intent. Callers processing a whole operation
// should use the batch `resolveIntentsForOp` (bottom): it fetches the value-independent
// payment-number pool AT MOST ONCE per op instead of once per value (#192/#191).
//
// The `switch (intent.kind)` below covers every `IdentifierKind` — exhaustive by
// construction (no `default`, every case returns): a new kind added without a case
// makes this function fall off the end and fails the server typecheck with TS2366
// ("Function lacks ending return statement"). `server/**` is now in the typecheck
// (`typecheck:server`, #187 fixed), so the compiler gates this; a test that runs every
// kind through the function (tests/intentResolver.test.ts) is the belt-and-suspenders.

import type { RecognitionIntent } from '../../app/utils/recognitionIntent'
import type { IdentifierKind } from '../../app/utils/purposeMatch'
import type { AllocationCandidate, AllocationTargetKind } from '../../app/utils/allocation'
import { filterByAccountNumber, filterByOrderNumber, filterByPaymentId, filterByPaymentIds, stripMaskLiteralPrefix } from '../../app/utils/allocation'
import type { RestCall } from './companyLookup'
import { SMART_INVOICE_ENTITY_TYPE_ID, type InvoiceLookupOptions } from './invoiceLookup'
import type { ItemByIdOptions } from './itemByIdLookup'
import { DEAL_ENTITY_TYPE_ID, type CompanyDealPaymentOptions } from './paymentLookup'
import type { DocumentEntityRef } from './documentLookup'

/** The entity resolvers this dispatch composes — injected for pure routing tests.
 *  Signatures mirror the real `invoiceLookup`/`itemByIdLookup`/`paymentLookup`. */
export interface IntentResolverDeps {
  findInvoicesByNumber: (accountNumber: string, opts: InvoiceLookupOptions, call: RestCall) => Promise<AllocationCandidate[]>
  findCandidateById: (kind: AllocationTargetKind, entityTypeId: number, id: string, opts: ItemByIdOptions, call: RestCall) => Promise<AllocationCandidate | null>
  /** Find a candidate whose CONFIGURED CRM field equals the recognized value
   *  (`by-config-field`, `deal-field`, §4). Mirrors `itemByIdLookup.findCandidateByField`. */
  findCandidateByField: (kind: AllocationTargetKind, entityTypeId: number, fieldName: string, value: string, opts: ItemByIdOptions, call: RestCall) => Promise<AllocationCandidate | null>
  findCompanyDealPayments: (companyId: string, opts: CompanyDealPaymentOptions, call: RestCall) => Promise<AllocationCandidate[]>
  /** Payment record ids of an order (via `sale.payment.list`, scope `sale`) — for
   *  `order-id`. NOT company-scoped; the resolver intersects them with the company pool. */
  findOrderPaymentIds: (orderId: string, call: RestCall) => Promise<string[]>
  /** Generated-document number → the CRM entity ref(s) it is bound to (`via-document`,
   *  §4). Mirrors `documentLookup.findDocumentEntities`. NOT company-scoped — the
   *  resolver re-checks each ref against the payer company via `findCandidateById`. */
  findDocumentEntities: (documentNumber: string, call: RestCall) => Promise<DocumentEntityRef[]>
}

/** Context for one intent resolution — the resolved payer company (IDOR scope for
 *  every lookup) and the negative-stage predicate (from `stageLoader`). */
export interface IntentContext {
  companyId: string
  isNegativeStage?: (stageId: string) => boolean
  /** The portal's «карта сопоставления» field map (`RecognitionSettings.configFields`):
   *  a config key → a CRM field name OR the smart-process entityTypeId. Consumed by the
   *  config-driven kinds: `deal-field` (field), `smart-field` (field + entityTypeId),
   *  `smart-id` (entityTypeId). A required key absent ⇒ that kind is `unsupported`. */
  configFields?: Record<string, string>
}

/** Config key in `configFields` for the deal user-field the payment number lives in
 *  (`deal-field`, §4). The deal's entityTypeId is the fixed CRM constant (2). */
export const DEAL_FIELD_CONFIG_KEY = 'deal-field'

/** Config key for the SMART-PROCESS entityTypeId (`smart-id`/`smart-field`, §4). Unlike a
 *  deal (fixed 2), a custom smart process's entityTypeId is portal-specific, so it must be
 *  configured. Stored as a string in `configFields`; parsed to a positive integer. */
export const SMART_ENTITY_CONFIG_KEY = 'smart-entity'
/** Config key for the smart-process user-field the number lives in (`smart-field`, §4). */
export const SMART_FIELD_CONFIG_KEY = 'smart-field'

/** Parse a configured entityTypeId (`configFields` value, a string) to a positive integer,
 *  or `null` when absent/blank/non-numeric — so a misconfigured value fails closed
 *  (`unsupported`) instead of querying a bogus entity type. */
export function parseConfiguredEntityTypeId(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number(String(raw).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

export type IntentStatus = 'resolved' | 'unsupported'

/** The outcome of dispatching one recognized intent. `candidates` is `[]` both when
 *  the kind is not yet dispatchable and when it is but nothing matched — the two are
 *  told apart by `status` (`reason` explains an `unsupported`). */
export interface IntentResolution {
  kind: IdentifierKind
  value: string
  status: IntentStatus
  candidates: AllocationCandidate[]
  reason?: string
}

/** Target kind + entityTypeId for the `by-id` kinds whose target type is a fixed,
 *  live-confirmed constant. Kept locally (not read from `route.targetKind`) so the
 *  dispatch needs no non-null assertion and doesn't hinge on another module staying
 *  non-null. `smart-id` is absent on purpose: a custom smart process's entityTypeId is
 *  portal-specific (from `configFields['smart-entity']`, not a constant) — its own case
 *  reads that config value rather than this table. */
const BY_ID_TARGET: Record<'invoice-id' | 'deal-id', { targetKind: AllocationTargetKind, entityTypeId: number }> = {
  'invoice-id': { targetKind: 'invoice', entityTypeId: SMART_INVOICE_ENTITY_TYPE_ID },
  'deal-id': { targetKind: 'deal', entityTypeId: DEAL_ENTITY_TYPE_ID }
}

const unsupported = (intent: RecognitionIntent, reason: string): IntentResolution =>
  ({ kind: intent.kind, value: intent.value, status: 'unsupported', candidates: [], reason })

/** Route one bridged document entity ref (`entityTypeId`) to the allocation target
 *  it must be resolved as (`via-document`, §4). Deal (2) and smart-invoice (31) are
 *  fixed CRM constants; a custom smart process's entityTypeId is portal-specific, so
 *  it matches ONLY the configured `configFields['smart-entity']`. Any other bound type
 *  (a quote, an estimate, an unconfigured SP) has no allocation target → `null` (the
 *  caller skips it). The `entityTypeId` returned is the numeric one to query with. */
export function routeDocumentRef(
  ref: DocumentEntityRef,
  configFields: Record<string, string> | undefined
): { targetKind: AllocationTargetKind, entityTypeId: number } | null {
  const etid = Number(String(ref.entityTypeId).trim())
  if (!Number.isInteger(etid) || etid <= 0) return null
  if (etid === DEAL_ENTITY_TYPE_ID) return { targetKind: 'deal', entityTypeId: etid }
  if (etid === SMART_INVOICE_ENTITY_TYPE_ID) return { targetKind: 'invoice', entityTypeId: etid }
  const smartEntity = parseConfiguredEntityTypeId(configFields?.[SMART_ENTITY_CONFIG_KEY])
  if (smartEntity !== null && etid === smartEntity) return { targetKind: 'smart-process', entityTypeId: etid }
  return null
}

/** Resolve a `payment-number` intent against an already-fetched company deal-payment
 *  pool — a pure `accountNumber` filter (no I/O). Split out so the single-intent and
 *  batch resolvers share one definition (the pool is fetched by the caller; the batch
 *  path fetches it ONCE per op — #191). Routed with the `'by-account-number'` strategy
 *  (#189) — matches by the payment's `accountNumber`, not by its own id. */
function resolvePaymentNumber(intent: RecognitionIntent, pool: AllocationCandidate[]): IntentResolution {
  // Strip the mask's literal prefix so a prefixed value (`ЗАК-6001`) matches the bare-numeric
  // deal-payment `accountNumber` (`6001/1`); the reported `value` stays the original (#242).
  return { kind: intent.kind, value: intent.value, status: 'resolved', candidates: filterByAccountNumber(pool, stripMaskLiteralPrefix(intent.value)) }
}

/** Resolve an `order-number` intent against the same company deal-payment pool — a pure
 *  PREFIX match (a payment's `accountNumber` is «<orderNumber>/<seq>», #172, live-confirmed).
 *  Shares the pool with `payment-number` (fetched once per op — #191). `order-id` is NOT
 *  routed here: the payment number carries the order's NUMBER, not its record id. */
function resolveOrderNumber(intent: RecognitionIntent, pool: AllocationCandidate[]): IntentResolution {
  // Strip the mask prefix before the «<order>/<seq>» prefix compare (bare-numeric target, #242).
  return { kind: intent.kind, value: intent.value, status: 'resolved', candidates: filterByOrderNumber(pool, stripMaskLiteralPrefix(intent.value)) }
}

/** Resolve a `payment-id` intent against the company deal-payment pool — a pure match
 *  by the payment's OWN record id (`filterByPaymentId`). IDOR-safe: the pool is already
 *  company-scoped, so an untrusted id only matches a payment of THIS company. No `sale`
 *  scope needed (the crm-scope pool already carries each payment's own id). */
function resolvePaymentId(intent: RecognitionIntent, pool: AllocationCandidate[]): IntentResolution {
  // Strip the mask prefix before the bare-integer payment-id compare (#242).
  return { kind: intent.kind, value: intent.value, status: 'resolved', candidates: filterByPaymentId(pool, stripMaskLiteralPrefix(intent.value)) }
}

/** Resolve an `order-id` intent (#172). UNLIKE the pure pool filters this needs one
 *  extra `sale`-scope call: `sale.payment.list` maps the order id → its payment ids
 *  (the crm pool carries no `orderId`), then we INTERSECT those ids with the company
 *  pool. IDOR-safe: the sale list is global, but only a payment also in the company
 *  pool survives the intersection. Shares the one pool fetch with the pure kinds. */
async function resolveOrderId(
  intent: RecognitionIntent,
  pool: AllocationCandidate[],
  call: RestCall,
  deps: IntentResolverDeps
): Promise<IntentResolution> {
  // Strip the mask prefix — `sale.payment.list` filters by the bare-integer orderId (#242).
  const orderPaymentIds = await deps.findOrderPaymentIds(stripMaskLiteralPrefix(intent.value), call)
  return { kind: intent.kind, value: intent.value, status: 'resolved', candidates: filterByPaymentIds(pool, orderPaymentIds) }
}

/** Kinds resolved by filtering the company deal-payment pool (value-independent fetch):
 *  the pure pool kinds PLUS `order-id` (which also needs the pool, for the IDOR intersection). */
function needsDealPaymentPool(kind: IdentifierKind): boolean {
  return usesDealPaymentPool(kind) || kind === 'order-id'
}

/** Kinds resolved by a PURE filter of the pool (no extra I/O). `order-id` is excluded —
 *  it needs a `sale` call before filtering, so it goes through `resolveOrderId`. */
function usesDealPaymentPool(kind: IdentifierKind): boolean {
  return kind === 'payment-number' || kind === 'order-number' || kind === 'payment-id'
}

/** Resolve a pool-based intent (payment-number exact / order-number prefix / payment-id). */
function resolveFromPool(intent: RecognitionIntent, pool: AllocationCandidate[]): IntentResolution {
  if (intent.kind === 'order-number') return resolveOrderNumber(intent, pool)
  if (intent.kind === 'payment-id') return resolvePaymentId(intent, pool)
  return resolvePaymentNumber(intent, pool)
}

/**
 * Dispatch one recognized intent to its entity resolver and return the allocation
 * candidates it finds (scoped to `ctx.companyId`, negative stages excluded). A REST
 * error from a resolver propagates. Kinds that still need portal-specific config or a
 * live-verify gate return `status: 'unsupported'` without calling any resolver.
 */
export async function resolveIntentCandidates(
  intent: RecognitionIntent,
  ctx: IntentContext,
  call: RestCall,
  deps: IntentResolverDeps
): Promise<IntentResolution> {
  const base = { kind: intent.kind, value: intent.value }
  const opts: ItemByIdOptions = { companyId: ctx.companyId, isNegativeStage: ctx.isNegativeStage }

  switch (intent.kind) {
    case 'invoice-number': {
      // Search the company's invoices by number — `value` keeps the mask's literal
      // prefix (accountNumber often IS `СЧ-1`, §4).
      const candidates = await deps.findInvoicesByNumber(intent.value, opts, call)
      return { ...base, status: 'resolved', candidates }
    }
    case 'invoice-id':
    case 'deal-id': {
      // The recognized value IS the entity's own id; resolve it directly, scoped to
      // the company (the id comes from the payer-controlled purpose → IDOR re-check).
      const { targetKind, entityTypeId } = BY_ID_TARGET[intent.kind]
      const found = await deps.findCandidateById(targetKind, entityTypeId, intent.value, opts, call)
      return { ...base, status: 'resolved', candidates: found ? [found] : [] }
    }
    case 'payment-number':
    case 'order-number':
    case 'payment-id': {
      // Company-scoped pool of deal payments, then match: `payment-number` by exact
      // `accountNumber`, `order-number` by the «<order>/<seq>» prefix, `payment-id` by the
      // payment's own record id (all #172/#189, live-confirmed; IDOR-safe via the company pool).
      const pool = await deps.findCompanyDealPayments(ctx.companyId, { isNegativeStage: ctx.isNegativeStage }, call)
      return resolveFromPool(intent, pool)
    }
    case 'order-id': {
      // order-id needs the company pool AND a `sale.payment.list` call (order id → payment ids,
      // since crm carries no `orderId`); intersect the two → IDOR-safe (#172, live-confirmed).
      const pool = await deps.findCompanyDealPayments(ctx.companyId, { isNegativeStage: ctx.isNegativeStage }, call)
      return resolveOrderId(intent, pool, call, deps)
    }
    case 'deal-field': {
      // Search the company's deals by a CONFIGURED user-field (from «карта сопоставления»),
      // scoped to the company (IDOR). The deal's entityTypeId is the fixed CRM constant (2);
      // only the field name is portal-specific. No configured field ⇒ can't look up → unsupported.
      const fieldName = ctx.configFields?.[DEAL_FIELD_CONFIG_KEY]
      if (!fieldName) return unsupported(intent, 'deal-field: no configured field (configFields["deal-field"])')
      const found = await deps.findCandidateByField('deal', DEAL_ENTITY_TYPE_ID, fieldName, intent.value, opts, call)
      return { ...base, status: 'resolved', candidates: found ? [found] : [] }
    }
    case 'smart-id': {
      // The value IS the smart-process element's own id. Unlike a deal, the smart process's
      // entityTypeId is portal-specific → read it from config; missing/invalid ⇒ unsupported.
      // ⚠ IDOR live-verify gate: the company scope relies on the SP having a `companyId` field
      // (live-confirmed for deals, NOT for an arbitrary configured SP). If a given SP has no
      // company binding, B24 may ignore the unknown filter key → scope fails open. Verify the
      // real portal's SP carries companyId before firing its trigger (log/count safe until then).
      const entityTypeId = parseConfiguredEntityTypeId(ctx.configFields?.[SMART_ENTITY_CONFIG_KEY])
      if (!entityTypeId) return unsupported(intent, 'smart-id: no configured entityTypeId (configFields["smart-entity"])')
      const found = await deps.findCandidateById('smart-process', entityTypeId, intent.value, opts, call)
      return { ...base, status: 'resolved', candidates: found ? [found] : [] }
    }
    case 'smart-field': {
      // Search the smart process by a CONFIGURED user-field. Needs BOTH the portal-specific
      // entityTypeId AND the field name from «карта сопоставления»; either missing ⇒ unsupported.
      const entityTypeId = parseConfiguredEntityTypeId(ctx.configFields?.[SMART_ENTITY_CONFIG_KEY])
      const fieldName = ctx.configFields?.[SMART_FIELD_CONFIG_KEY]
      if (!entityTypeId) return unsupported(intent, 'smart-field: no configured entityTypeId (configFields["smart-entity"])')
      if (!fieldName) return unsupported(intent, 'smart-field: no configured field (configFields["smart-field"])')
      const found = await deps.findCandidateByField('smart-process', entityTypeId, fieldName, intent.value, opts, call)
      return { ...base, status: 'resolved', candidates: found ? [found] : [] }
    }
    case 'document-number': {
      // Bridge: number → generated document(s) → bound entity ref(s). Route each ref by
      // its `entityTypeId`, then resolve it by id SCOPED TO THE PAYER COMPANY (IDOR — the
      // number is payer-controlled and the document list has no company filter). Unroutable
      // refs (a quote/estimate, an unconfigured SP) are skipped. Live-verified on the test
      // portal (document.list reverse `filter:{number}` honored; entityTypeId/entityId present).
      //
      // NB: pass the value UNSTRIPPED (mirrors the invoice-number path, NOT the bare-id
      // paths). A document's `number` is matched LITERALLY by `filter:{number}` and the
      // mask's literal prefix is part of that formatted number (the numerator template
      // emits it) — stripping `ДОК-0001`→`0001` would miss the real document.
      const refs = await deps.findDocumentEntities(intent.value, call)
      const candidates: AllocationCandidate[] = []
      for (const ref of refs) {
        const routed = routeDocumentRef(ref, ctx.configFields)
        if (!routed) continue
        const found = await deps.findCandidateById(routed.targetKind, routed.entityTypeId, ref.entityId, opts, call)
        if (found) candidates.push(found)
      }
      return { ...base, status: 'resolved', candidates }
    }
  }
}

/**
 * Resolve ALL recognized intents of ONE operation, de-duplicating the expensive
 * company-wide lookup (#191): the deal-payment pool (`findCompanyDealPayments`) is
 * company-scoped and value-independent, so it's fetched AT MOST ONCE and reused for
 * every pooled intent (`payment-number`/`order-number`/`payment-id`, plus `order-id`
 * which also intersects the pool) — instead of one full company scan per value (the
 * amplification the security review flagged). `order-id` still makes its own per-value
 * `sale.payment.list` call, but shares this single pool fetch. All other kinds go through
 * the single-intent `resolveIntentCandidates`. A REST error propagates. Order preserved.
 */
export async function resolveIntentsForOp(
  intents: RecognitionIntent[],
  ctx: IntentContext,
  call: RestCall,
  deps: IntentResolverDeps
): Promise<IntentResolution[]> {
  // Fetch the deal-payment pool once, only if some intent actually needs it — the pure
  // pool kinds (payment-number/order-number/payment-id) AND order-id (pool intersection).
  const needsPool = intents.some(i => needsDealPaymentPool(i.kind))
  const pool = needsPool
    ? await deps.findCompanyDealPayments(ctx.companyId, { isNegativeStage: ctx.isNegativeStage }, call)
    : []
  const out: IntentResolution[] = []
  for (const intent of intents) {
    if (usesDealPaymentPool(intent.kind)) out.push(resolveFromPool(intent, pool)) // pure pool filter
    else if (intent.kind === 'order-id') out.push(await resolveOrderId(intent, pool, call, deps)) // pool + sale call
    else out.push(await resolveIntentCandidates(intent, ctx, call, deps))
  }
  return out
}
