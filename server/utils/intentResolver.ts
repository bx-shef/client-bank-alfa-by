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
// The `switch (intent.kind)` below covers every `IdentifierKind` — exhaustive by
// construction (no `default`, every case returns): a new kind added without a case
// makes this function fall off the end and fails the server typecheck with TS2366
// ("Function lacks ending return statement"). `server/**` is now in the typecheck
// (`typecheck:server`, #187 fixed), so the compiler gates this; a test that runs every
// kind through the function (tests/intentResolver.test.ts) is the belt-and-suspenders.

import type { RecognitionIntent } from '../../app/utils/recognitionIntent'
import type { IdentifierKind } from '../../app/utils/purposeMatch'
import type { AllocationCandidate, AllocationTargetKind } from '../../app/utils/allocation'
import { filterByAccountNumber } from '../../app/utils/allocation'
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
    case 'payment-number': {
      // Company-scoped pool of deal payments, then the exact `accountNumber` match.
      // NB: routed `'via-payment'` but this is by-number semantics — taxonomy note #189.
      const pool = await deps.findCompanyDealPayments(ctx.companyId, { isNegativeStage: ctx.isNegativeStage }, call)
      return { ...base, status: 'resolved', candidates: filterByAccountNumber(pool, intent.value) }
    }
    case 'smart-id':
    case 'deal-field':
    case 'smart-field':
      // Need the entityTypeId / field name from the portal's «карта сопоставления».
      return unsupported(intent, `${intent.kind}: needs configured entityTypeId/field (deal-field/smart-field slice)`)
    case 'order-id':
    case 'order-number':
      // order↔payment link (`<order>/<seq>`) not live-verified yet (#172).
      return unsupported(intent, `${intent.kind}: order↔payment link not live-verified (#172)`)
    case 'payment-id':
      // Resolve-payment-by-own-id path not live-verified yet.
      return unsupported(intent, 'payment-id: resolve-by-id path not live-verified yet')
    case 'document-number':
      // Document bridge needs a live-verified template+document first (#184-adjacent).
      return unsupported(intent, 'document-number: document bridge needs live-verify')
  }
}
