import { describe, expect, it } from 'vitest'
import { B24_REQUIRED_SCOPES } from '~/config/b24'

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
