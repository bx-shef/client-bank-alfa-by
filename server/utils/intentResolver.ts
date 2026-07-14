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
import { filterByAccountNumber, filterByOrderNumber, filterByPaymentId } from '../../app/utils/allocation'
import type { RestCall } from './companyLookup'
import { SMART_INVOICE_ENTITY_TYPE_ID, type InvoiceLookupOptions } from './invoiceLookup'
import type { ItemByIdOptions } from './itemByIdLookup'
import { DEAL_ENTITY_TYPE_ID, type CompanyDealPaymentOptions } from './paymentLookup'

/** The entity resolvers this dispatch composes — injected for pure routing tests.
 *  Signatures mirror the real `invoiceLookup`/`itemByIdLookup`/`paymentLookup`. */
export interface IntentResolverDeps {
  findInvoicesByNumber: (accountNumber: string, opts: InvoiceLookupOptions, call: RestCall) => Promise<AllocationCandidate[]>
  findCandidateById: (kind: AllocationTargetKind, entityTypeId: number, id: string, opts: ItemByIdOptions, call: RestCall) => Promise<AllocationCandidate | null>
  findCompanyDealPayments: (companyId: string, opts: CompanyDealPaymentOptions, call: RestCall) => Promise<AllocationCandidate[]>
}

/** Context for one intent resolution — the resolved payer company (IDOR scope for
 *  every lookup) and the negative-stage predicate (from `stageLoader`). */
export interface IntentContext {
  companyId: string
  isNegativeStage?: (stageId: string) => boolean
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
 *  portal-specific (from the mapping config, not a constant) — handled as `unsupported`
 *  until the config slice lands. */
const BY_ID_TARGET: Record<'invoice-id' | 'deal-id', { targetKind: AllocationTargetKind, entityTypeId: number }> = {
  'invoice-id': { targetKind: 'invoice', entityTypeId: SMART_INVOICE_ENTITY_TYPE_ID },
  'deal-id': { targetKind: 'deal', entityTypeId: DEAL_ENTITY_TYPE_ID }
}

const unsupported = (intent: RecognitionIntent, reason: string): IntentResolution =>
  ({ kind: intent.kind, value: intent.value, status: 'unsupported', candidates: [], reason })

/** Resolve a `payment-number` intent against an already-fetched company deal-payment
 *  pool — a pure `accountNumber` filter (no I/O). Split out so the single-intent and
 *  batch resolvers share one definition (the pool is fetched by the caller; the batch
 *  path fetches it ONCE per op — #191). Routed with the `'by-account-number'` strategy
 *  (#189) — matches by the payment's `accountNumber`, not by its own id. */
function resolvePaymentNumber(intent: RecognitionIntent, pool: AllocationCandidate[]): IntentResolution {
  return { kind: intent.kind, value: intent.value, status: 'resolved', candidates: filterByAccountNumber(pool, intent.value) }
}

/** Resolve an `order-number` intent against the same company deal-payment pool — a pure
 *  PREFIX match (a payment's `accountNumber` is «<orderNumber>/<seq>», #172, live-confirmed).
 *  Shares the pool with `payment-number` (fetched once per op — #191). `order-id` is NOT
 *  routed here: the payment number carries the order's NUMBER, not its record id. */
function resolveOrderNumber(intent: RecognitionIntent, pool: AllocationCandidate[]): IntentResolution {
  return { kind: intent.kind, value: intent.value, status: 'resolved', candidates: filterByOrderNumber(pool, intent.value) }
}

/** Resolve a `payment-id` intent against the company deal-payment pool — a pure match
 *  by the payment's OWN record id (`filterByPaymentId`). IDOR-safe: the pool is already
 *  company-scoped, so an untrusted id only matches a payment of THIS company. No `sale`
 *  scope needed (the crm-scope pool already carries each payment's own id). */
function resolvePaymentId(intent: RecognitionIntent, pool: AllocationCandidate[]): IntentResolution {
  return { kind: intent.kind, value: intent.value, status: 'resolved', candidates: filterByPaymentId(pool, intent.value) }
}

/** Kinds resolved by filtering the company deal-payment pool (value-independent fetch). */
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
    case 'smart-id':
    case 'deal-field':
    case 'smart-field':
      // Need the entityTypeId / field name from the portal's «карта сопоставления».
      return unsupported(intent, `${intent.kind}: needs configured entityTypeId/field (deal-field/smart-field slice)`)
    case 'order-id':
      // Resolving an order by its own record id needs `sale.order.list` (scope `sale`) to map
      // id→order→payment: the payment number carries the order's NUMBER, and `crm.item.payment.list`
      // does NOT expose `orderId` (live-confirmed), so the crm-scope company pool can't match by order id (#172).
      return unsupported(intent, 'order-id: id→order→payment needs sale scope (#172)')
    case 'document-number':
      // Document bridge needs a live-verified template+document first (#184-adjacent).
      return unsupported(intent, 'document-number: document bridge needs live-verify')
  }
}

/**
 * Resolve ALL recognized intents of ONE operation, de-duplicating the expensive
 * company-wide lookup (#191): the deal-payment pool (`findCompanyDealPayments`) is
 * company-scoped and value-independent, so it's fetched AT MOST ONCE and reused for
 * every pooled intent (`payment-number`/`order-number`/`payment-id`) — instead of one
 * full company scan per value (the amplification the security review flagged). All other
 * kinds go through the single-intent `resolveIntentCandidates`. A REST error propagates.
 * Order preserved.
 */
export async function resolveIntentsForOp(
  intents: RecognitionIntent[],
  ctx: IntentContext,
  call: RestCall,
  deps: IntentResolverDeps
): Promise<IntentResolution[]> {
  // Fetch the deal-payment pool once, only if some intent actually needs it
  // (payment-number / order-number / payment-id — all filter the same value-independent pool).
  const needsPool = intents.some(i => usesDealPaymentPool(i.kind))
  const pool = needsPool
    ? await deps.findCompanyDealPayments(ctx.companyId, { isNegativeStage: ctx.isNegativeStage }, call)
    : []
  const out: IntentResolution[] = []
  for (const intent of intents) {
    out.push(
      usesDealPaymentPool(intent.kind)
        ? resolveFromPool(intent, pool)
        : await resolveIntentCandidates(intent, ctx, call, deps)
    )
  }
  return out
}
