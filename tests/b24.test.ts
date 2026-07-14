import { describe, expect, it } from 'vitest'
import { B24_REQUIRED_SCOPES } from '~/config/b24'

describe('B24_REQUIRED_SCOPES', () => {
  it('lists crm, sale, im, user_brief and placement', () => {
    // `sale` is needed to resolve an order-id → its payments (sale.payment.list, #172).
    expect([...B24_REQUIRED_SCOPES]).toEqual(['crm', 'sale', 'im', 'user_brief', 'placement'])
  })

  it('has no duplicate scopes', () => {
    expect(new Set(B24_REQUIRED_SCOPES).size).toBe(B24_REQUIRED_SCOPES.length)
  })
})
