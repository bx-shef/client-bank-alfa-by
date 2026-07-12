import { describe, expect, it } from 'vitest'
import { buildAllocationErrorMessage } from '~/utils/allocationErrorMessage'
import type { AllocationDecision } from '~/utils/allocation'
import type { StatementItem } from '~/types/statement'

function item(partial: Partial<StatementItem> = {}): StatementItem {
  return {
    account: 'A', docId: 'd1', direction: 'credit', amount: 1840, currency: 'BYN',
    purpose: 'оплата', counterparty: { name: 'ООО Ромашка', unp: '1', account: 'BY1' },
    acceptDate: '2026-07-01T00:00:00.000Z', ...partial
  }
}

const ambiguous: AllocationDecision = {
  action: 'allocate',
  target: { kind: 'invoice', id: '5', amount: 1840, currency: 'BYN' },
  ambiguous: true,
  alternatives: [{ kind: 'deal-payment', id: '9', amount: 1840, currency: 'BYN' }]
}
const manual: AllocationDecision = {
  action: 'manual', reason: 'no-exact-match',
  candidates: [{ kind: 'invoice', id: '7', amount: 100, currency: 'BYN' }]
}
const cleanAllocate: AllocationDecision = {
  action: 'allocate', target: { kind: 'invoice', id: '5', amount: 1840, currency: 'BYN' },
  ambiguous: false, alternatives: []
}
const none: AllocationDecision = { action: 'none', reason: 'no-candidates' }

describe('buildAllocationErrorMessage', () => {
  it('builds an ambiguous heads-up with the chosen target + alternatives', () => {
    const msg = buildAllocationErrorMessage(item(), ambiguous)!
    expect(msg).toContain('Неоднозначное разнесение')
    expect(msg).toContain('смарт-счёт #5') // chosen (smallest id)
    expect(msg).toContain('оплата сделки #9') // alternative
    expect(msg).toContain('Проверьте вручную')
  })

  it('builds a manual notice listing the candidates', () => {
    const msg = buildAllocationErrorMessage(item(), manual)!
    expect(msg).toContain('Не удалось разнести автоматически')
    expect(msg).toContain('смарт-счёт #7')
  })

  it('returns null for a clean single-target allocate and for none', () => {
    expect(buildAllocationErrorMessage(item(), cleanAllocate)).toBeNull()
    expect(buildAllocationErrorMessage(item(), none)).toBeNull()
  })

  it('neutralizes BB-code in the payer-controlled counterparty name', () => {
    // The headline carries the counterparty name; a crafted name must not inject BB.
    const msg = buildAllocationErrorMessage(item({ counterparty: { name: '[url=http://evil]x[/url]', unp: '1', account: 'BY1' } }), manual)!
    expect(msg).not.toContain('[url=') // neutralized (brackets → fullwidth)
  })
})
