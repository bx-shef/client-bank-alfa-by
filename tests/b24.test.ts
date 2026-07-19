import { describe, expect, it } from 'vitest'
import { B24_ALL_BOUND_EVENTS, B24_BOUND_EVENTS, B24_DELETION_EVENTS, B24_REQUIRED_SCOPES } from '~/config/b24'

describe('B24_REQUIRED_SCOPES', () => {
  it('lists crm, sale, im, documentgenerator, user_brief and placement', () => {
    // `sale` — resolve an order-id → its payments (sale.payment.list, #172).
    // `documentgenerator` — the via-document bridge (crm.documentgenerator.document.list, #109).
    expect([...B24_REQUIRED_SCOPES]).toEqual(['crm', 'sale', 'im', 'documentgenerator', 'user_brief', 'placement'])
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
