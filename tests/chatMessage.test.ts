import { describe, expect, it } from 'vitest'
import type { StatementItem } from '~/types/statement'
import { buildChatHeadline, buildChatMessage } from '~/utils/chatMessage'
import { formatMoney } from '~/utils/activity'

function makeItem(over: Partial<StatementItem> = {}): StatementItem {
  return {
    account: 'BY80ALFA30121122220090270000',
    docId: '100231',
    docNum: '541',
    direction: 'credit',
    amount: 1840,
    currency: 'BYN',
    purpose: 'Оплата по счёту №541',
    counterparty: { name: 'ООО «Ромашка»', unp: '191234567', account: 'BY24X', bank: 'Альфа-Банк' },
    acceptDate: '2026-06-26T00:00:00.000Z',
    ...over
  }
}

describe('buildChatHeadline', () => {
  it('is the bold-able one-line title (direction + amount + counterparty)', () => {
    expect(buildChatHeadline(makeItem())).toBe(`Приход ${formatMoney(1840)} BYN от ООО «Ромашка»`)
  })
})

describe('buildChatMessage', () => {
  it('bolds the headline and includes purpose, document date and account', () => {
    const msg = buildChatMessage(makeItem())
    expect(msg).toContain(`[b]Приход ${formatMoney(1840)} BYN от ООО «Ромашка»[/b]`)
    expect(msg).toContain('Назначение: Оплата по счёту №541')
    expect(msg).toContain('Документ №541 от 26.06.2026')
    expect(msg).toContain('Счёт: BY24X')
  })

  it('uses the plain document form when there is no docNum', () => {
    const msg = buildChatMessage(makeItem({ docNum: undefined, purpose: 'Оплата' }))
    expect(msg).toContain('Документ от 26.06.2026')
    expect(msg).not.toContain('Документ №')
  })

  it('omits the purpose line when purpose is blank', () => {
    const msg = buildChatMessage(makeItem({ purpose: '   ' }))
    expect(msg).not.toContain('Назначение:')
  })

  it('omits the account line when the counterparty account is blank', () => {
    const msg = buildChatMessage(makeItem({ counterparty: { name: 'X', unp: '1', account: '' } }))
    expect(msg).not.toContain('Счёт:')
  })

  it('renders a debit headline with "Расход … на"', () => {
    expect(buildChatMessage(makeItem({ direction: 'debit' }))).toContain('[b]Расход')
  })
})
