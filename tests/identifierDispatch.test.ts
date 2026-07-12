import { describe, expect, it } from 'vitest'
import type { AllocationTargetKind } from '~/utils/allocation'
import type { IdentifierKind } from '~/utils/purposeMatch'
import type { LookupStrategy } from '~/utils/identifierDispatch'
import { IDENTIFIER_ROUTES, routeIdentifier } from '~/utils/identifierDispatch'

// Pure dispatch table (#109): every recognized IdentifierKind (§4) routes to an
// allocation target and a lookup strategy. No I/O — just the routing decision.
// Taxonomy is NOT duplicated here — kinds are read back from the table itself
// (the Record<IdentifierKind, …> type already forces the table to be exhaustive;
// deriving the test list means it can never drift into a stale third copy).
const ALL_KINDS = Object.keys(IDENTIFIER_ROUTES) as IdentifierKind[]

// Single source of truth for the valid target set — `satisfies` keeps it in sync
// with AllocationTargetKind at compile time (a new kind must be added here).
const VALID_TARGETS = { 'invoice': true, 'deal-payment': true, 'deal': true, 'smart-process': true } satisfies Record<AllocationTargetKind, true>
const VALID_STRATEGIES: LookupStrategy[] = ['by-id', 'by-number', 'by-account-number', 'by-config-field', 'via-order', 'via-payment', 'via-document']

describe('IDENTIFIER_ROUTES', () => {
  it('has a route for every kind (11) and no undefined entries', () => {
    expect(ALL_KINDS).toHaveLength(11)
    for (const kind of ALL_KINDS) expect(IDENTIFIER_ROUTES[kind], `route for ${kind}`).toBeDefined()
  })

  it('invoice identifiers → invoice target', () => {
    expect(routeIdentifier('invoice-number')).toEqual({ targetKind: 'invoice', strategy: 'by-number', needsConfiguredField: false })
    expect(routeIdentifier('invoice-id')).toEqual({ targetKind: 'invoice', strategy: 'by-id', needsConfiguredField: false })
  })

  it('deal identifiers → deal target; custom field needs config', () => {
    expect(routeIdentifier('deal-id')).toEqual({ targetKind: 'deal', strategy: 'by-id', needsConfiguredField: false })
    expect(routeIdentifier('deal-field')).toEqual({ targetKind: 'deal', strategy: 'by-config-field', needsConfiguredField: true })
  })

  it('order/payment identifiers → deal-payment target (each strategy explicit)', () => {
    expect(routeIdentifier('order-id')).toEqual({ targetKind: 'deal-payment', strategy: 'via-order', needsConfiguredField: false })
    expect(routeIdentifier('order-number')).toEqual({ targetKind: 'deal-payment', strategy: 'via-order', needsConfiguredField: false })
    // payment-id resolves by its OWN id (via-payment); payment-number by accountNumber
    // within the company pool (by-account-number) — distinct strategies (#189).
    expect(routeIdentifier('payment-id')).toEqual({ targetKind: 'deal-payment', strategy: 'via-payment', needsConfiguredField: false })
    expect(routeIdentifier('payment-number')).toEqual({ targetKind: 'deal-payment', strategy: 'by-account-number', needsConfiguredField: false })
    expect(routeIdentifier('payment-number').strategy).not.toBe(routeIdentifier('payment-id').strategy)
  })

  it('smart-process identifiers → smart-process target; custom field needs config', () => {
    expect(routeIdentifier('smart-id')).toEqual({ targetKind: 'smart-process', strategy: 'by-id', needsConfiguredField: false })
    expect(routeIdentifier('smart-field')).toEqual({ targetKind: 'smart-process', strategy: 'by-config-field', needsConfiguredField: true })
  })

  it('document-number is a bridge — no fixed target, via-document', () => {
    expect(routeIdentifier('document-number')).toEqual({ targetKind: null, strategy: 'via-document', needsConfiguredField: false })
  })

  it('only the two custom-field kinds need a configured field', () => {
    const needConfig = ALL_KINDS.filter(k => IDENTIFIER_ROUTES[k].needsConfiguredField)
    expect(needConfig.sort()).toEqual(['deal-field', 'smart-field'])
  })

  it('every route uses a known strategy and a valid (or null) target', () => {
    for (const kind of ALL_KINDS) {
      const route = IDENTIFIER_ROUTES[kind]
      expect(VALID_STRATEGIES, `strategy of ${kind}`).toContain(route.strategy)
      if (route.targetKind !== null) {
        expect(Object.hasOwn(VALID_TARGETS, route.targetKind), `${kind} → ${route.targetKind}`).toBe(true)
      }
    }
  })
})
