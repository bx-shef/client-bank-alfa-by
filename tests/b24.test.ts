import { describe, expect, it } from 'vitest'
import { B24_ALL_BOUND_EVENTS, B24_BOUND_EVENTS, B24_DELETION_EVENTS, B24_REQUIRED_SCOPES, marketDetailPath } from '~/config/b24'

describe('B24_REQUIRED_SCOPES', () => {
  it('lists crm, sale, im, documentgenerator, userfieldconfig, user_brief and placement', () => {
    // `sale` — resolve an order-id → its payments (sale.payment.list, #172).
    // `documentgenerator` — the via-document bridge (crm.documentgenerator.document.list, #109).
    // `userfieldconfig` — distribution SP provisioning creates its custom fields (#408); the code
    // called `userfieldconfig.add` while the scope was NOT requested, so provisioning failed on
    // every portal that hadn't been granted it by hand.
    expect([...B24_REQUIRED_SCOPES]).toEqual(['crm', 'sale', 'im', 'documentgenerator', 'userfieldconfig', 'user_brief', 'placement'])
  })

  it('has no duplicate scopes', () => {
    expect(new Set(B24_REQUIRED_SCOPES).size).toBe(B24_REQUIRED_SCOPES.length)
  })
})

describe('B24_ALL_BOUND_EVENTS', () => {
  it('is the lifecycle events followed by the deletion events (§9.2), no duplicates', () => {
    expect([...B24_ALL_BOUND_EVENTS]).toEqual([...B24_BOUND_EVENTS, ...B24_DELETION_EVENTS])
    expect(new Set(B24_ALL_BOUND_EVENTS).size).toBe(B24_ALL_BOUND_EVENTS.length)
  })
})

describe('marketDetailPath', () => {
  it('builds the Bitrix24 Market detail path from a listing code', () => {
    expect(marketDetailPath('shef.bankimport')).toBe('/marketplace/detail/shef.bankimport/')
  })

  it('trims surrounding whitespace before building the path', () => {
    expect(marketDetailPath('  shef.bankimport  ')).toBe('/marketplace/detail/shef.bankimport/')
  })

  it('returns null for an empty / whitespace-only code (feature off)', () => {
    expect(marketDetailPath('')).toBeNull()
    expect(marketDetailPath('   ')).toBeNull()
  })
})
