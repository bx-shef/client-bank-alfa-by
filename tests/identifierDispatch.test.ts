import { describe, expect, it } from 'vitest'
import type { IdentifierKind } from '~/utils/purposeMatch'
import { IDENTIFIER_ROUTES, routeIdentifier } from '~/utils/identifierDispatch'

// Pure dispatch table (#109): every recognized IdentifierKind (§4) routes to an
// allocation target and a lookup strategy. No I/O — just the routing decision.

// The full taxonomy from purposeMatch.ts §4, kept here so the "exhaustive" test
// fails loudly if IdentifierKind grows without a matching route.
const ALL_KINDS: IdentifierKind[] = [
  'invoice-number', 'invoice-id',
  'deal-id', 'deal-field',
  'order-id', 'order-number',
  'payment-id', 'payment-number',
  'smart-id', 'smart-field',
  'document-number'
]

describe('IDENTIFIER_ROUTES', () => {
  it('routes every IdentifierKind (exhaustive, no extras)', () => {
    expect(Object.keys(IDENTIFIER_ROUTES).sort()).toEqual([...ALL_KINDS].sort())
    for (const kind of ALL_KINDS) {
      expect(IDENTIFIER_ROUTES[kind], `route for ${kind}`).toBeDefined()
    }
  })

  it('invoice identifiers → invoice target', () => {
    expect(routeIdentifier('invoice-number')).toEqual({ targetKind: 'invoice', strategy: 'by-number', needsConfiguredField: false })
    expect(routeIdentifier('invoice-id')).toEqual({ targetKind: 'invoice', strategy: 'by-id', needsConfiguredField: false })
  })

  it('deal identifiers → deal target; custom field needs config', () => {
    expect(routeIdentifier('deal-id')).toMatchObject({ targetKind: 'deal', strategy: 'by-id', needsConfiguredField: false })
    expect(routeIdentifier('deal-field')).toMatchObject({ targetKind: 'deal', strategy: 'by-config-field', needsConfiguredField: true })
  })

  it('order/payment identifiers → deal-payment target', () => {
    for (const k of ['order-id', 'order-number', 'payment-id', 'payment-number'] as const) {
      expect(routeIdentifier(k).targetKind, k).toBe('deal-payment')
    }
    expect(routeIdentifier('order-number').strategy).toBe('via-order')
    expect(routeIdentifier('payment-id').strategy).toBe('via-payment')
  })

  it('smart-process identifiers → smart-process target; custom field needs config', () => {
    expect(routeIdentifier('smart-id')).toMatchObject({ targetKind: 'smart-process', needsConfiguredField: false })
    expect(routeIdentifier('smart-field')).toMatchObject({ targetKind: 'smart-process', strategy: 'by-config-field', needsConfiguredField: true })
  })

  it('document-number is a bridge — no fixed target, via-document', () => {
    expect(routeIdentifier('document-number')).toEqual({ targetKind: null, strategy: 'via-document', needsConfiguredField: false })
  })

  it('only the two custom-field kinds need a configured field', () => {
    const needConfig = ALL_KINDS.filter(k => IDENTIFIER_ROUTES[k].needsConfiguredField)
    expect(needConfig.sort()).toEqual(['deal-field', 'smart-field'])
  })

  it('every non-bridge route yields a valid AllocationTargetKind', () => {
    const valid = new Set(['invoice', 'deal-payment', 'deal', 'smart-process'])
    for (const kind of ALL_KINDS) {
      const t = IDENTIFIER_ROUTES[kind].targetKind
      if (t !== null) expect(valid.has(t), `${kind} → ${t}`).toBe(true)
    }
  })
})
