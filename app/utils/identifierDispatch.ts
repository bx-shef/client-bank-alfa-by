import type { AllocationTargetKind } from '~/utils/allocation'
import type { IdentifierKind } from '~/utils/purposeMatch'

// Pure routing layer between recognition (§4) and the entity lookup (#109): given
// an `IdentifierKind` recognized from the payment purpose, decide WHICH allocation
// target it resolves to and HOW to look it up. No I/O and no hard-coded field
// names — the actual REST search (and the per-direction / per-smart-process field
// from the settings «карта сопоставления») lives in the wiring slice. This table
// is the single source of truth for that dispatch, kept exhaustive by the
// `Record<IdentifierKind, …>` type (a new kind fails to compile until routed).

/** How the recognized value is turned into an entity to allocate against. */
export type LookupStrategy
  = | 'by-id' // the value IS the entity's own CRM id
    | 'by-number' // search the entity by its human-facing number field
    | 'by-account-number' // search a payment by its `accountNumber` within the company's deal-payment pool (#189)
    | 'by-order-number' // match a payment by the order PREFIX of its `accountNumber` («<order>/<seq>», #172)
    | 'by-payment-id' // match a payment by its OWN record id within the company's deal-payment pool (#172)
    | 'by-config-field' // search by a portal-configured field (per direction / per process)
    | 'via-order' // value identifies an order by its OWN id → resolve to its deal payment (needs sale scope)
    | 'via-document' // value is a generated-document number → bridge to its linked entity

// NB (§2): a `deal` / `smart-process` target reached by `by-id` / `by-config-field`
// is an UNCONDITIONAL trigger target — the wiring slice fires its trigger directly
// and does NOT run it through the amount-based `resolveAllocation` (that core is
// only for search-found `invoice` / `deal-payment`, where many same-amount
// candidates are possible). Also: a `by-id` result MUST be re-checked against the
// resolved companies + stage before acting — the value comes from the payer-
// controlled purpose, so a direct id lookup without that check would be an IDOR.

/** The dispatch decision for one identifier kind. */
export interface IdentifierRoute {
  /** The allocation target this identifier resolves to. `null` for the document
   *  bridge — the target depends on the linked entity (`entityTypeId`), decided
   *  after the document is fetched. */
  targetKind: AllocationTargetKind | null
  strategy: LookupStrategy
  /** True when the lookup needs a portal-configured field name (карта
   *  сопоставления, §4) rather than a fixed CRM field. */
  needsConfiguredField: boolean
}

/** Exhaustive routing table — one entry per `IdentifierKind` (§4). */
export const IDENTIFIER_ROUTES: Record<IdentifierKind, IdentifierRoute> = {
  'invoice-number': { targetKind: 'invoice', strategy: 'by-number', needsConfiguredField: false },
  'invoice-id': { targetKind: 'invoice', strategy: 'by-id', needsConfiguredField: false },
  'deal-id': { targetKind: 'deal', strategy: 'by-id', needsConfiguredField: false },
  'deal-field': { targetKind: 'deal', strategy: 'by-config-field', needsConfiguredField: true },
  'order-id': { targetKind: 'deal-payment', strategy: 'via-order', needsConfiguredField: false },
  // Resolved by the order PREFIX of a payment's `accountNumber` («<order>/<seq>») within the
  // company's deal-payment pool (intentResolver: findCompanyDealPayments + filterByOrderNumber,
  // #172, live-confirmed) — the order's NUMBER, not its record id (that's `order-id`/`via-order`).
  'order-number': { targetKind: 'deal-payment', strategy: 'by-order-number', needsConfiguredField: false },
  // Resolved by the payment's OWN record id within the company's deal-payment pool
  // (intentResolver: findCompanyDealPayments + filterByPaymentId, #172, live-confirmed) —
  // IDOR-safe (pool is company-scoped), no `sale` scope. Distinct from payment-number (by accountNumber).
  'payment-id': { targetKind: 'deal-payment', strategy: 'by-payment-id', needsConfiguredField: false },
  // Resolved by `accountNumber` within the company's deal-payment pool (intentResolver:
  // findCompanyDealPayments + filterByAccountNumber) — by-number semantics, NOT by own id
  // (that's `payment-id`/`by-payment-id`). Distinct label per #189.
  'payment-number': { targetKind: 'deal-payment', strategy: 'by-account-number', needsConfiguredField: false },
  // `needsConfiguredField: true` — a smart process's `entityTypeId` is portal-specific
  // (custom SP), so even a by-id lookup needs that configured value before it can run.
  // Until the config slice lands, `intentResolver` routes smart-id to `unsupported`.
  'smart-id': { targetKind: 'smart-process', strategy: 'by-id', needsConfiguredField: true },
  'smart-field': { targetKind: 'smart-process', strategy: 'by-config-field', needsConfiguredField: true },
  'document-number': { targetKind: null, strategy: 'via-document', needsConfiguredField: false }
}

/** Route a recognized identifier kind to its lookup decision. */
export function routeIdentifier(kind: IdentifierKind): IdentifierRoute {
  return IDENTIFIER_ROUTES[kind]
}
