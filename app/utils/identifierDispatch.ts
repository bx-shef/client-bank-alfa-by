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
    | 'by-config-field' // search by a portal-configured field (per direction / per process)
    | 'via-order' // value identifies an order → resolve to its deal payment
    | 'via-payment' // value identifies a payment record directly
    | 'via-document' // value is a generated-document number → bridge to its linked entity

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
  'order-number': { targetKind: 'deal-payment', strategy: 'via-order', needsConfiguredField: false },
  'payment-id': { targetKind: 'deal-payment', strategy: 'via-payment', needsConfiguredField: false },
  'payment-number': { targetKind: 'deal-payment', strategy: 'via-payment', needsConfiguredField: false },
  'smart-id': { targetKind: 'smart-process', strategy: 'by-id', needsConfiguredField: false },
  'smart-field': { targetKind: 'smart-process', strategy: 'by-config-field', needsConfiguredField: true },
  'document-number': { targetKind: null, strategy: 'via-document', needsConfiguredField: false }
}

/** Route a recognized identifier kind to its lookup decision. */
export function routeIdentifier(kind: IdentifierKind): IdentifierRoute {
  return IDENTIFIER_ROUTES[kind]
}
