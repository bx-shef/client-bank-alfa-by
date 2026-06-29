import { describe, expect, it } from 'vitest'
import type { StatementItem } from '~/types/statement'
import {
  ACTIVITY_ORIGIN,
  CRM_OWNER_TYPE_COMPANY,
  activityOriginToken,
  buildActivityTitle,
  buildTodoActivity
} from '~/utils/activity'

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

describe('activityOriginToken', () => {
  it('embeds origin + account|docId for dedup search', () => {
    expect(activityOriginToken(makeItem())).toBe(`[${ACTIVITY_ORIGIN}:BY80ALFA30121122220090270000|100231]`)
  })
})

describe('buildActivityTitle', () => {
  it('uses "Приход … от" for credits', () => {
    expect(buildActivityTitle(makeItem({ direction: 'credit' }))).toBe('Приход 1840 BYN от ООО «Ромашка»')
  })
  it('uses "Расход … на" for debits', () => {
    expect(buildActivityTitle(makeItem({ direction: 'debit' }))).toBe('Расход 1840 BYN на ООО «Ромашка»')
  })
})

describe('buildTodoActivity', () => {
  it('binds to the company and carries the required deadline', () => {
    const params = buildTodoActivity(makeItem(), { id: 77, assignedById: 5 })
    expect(params.ownerTypeId).toBe(CRM_OWNER_TYPE_COMPANY)
    expect(params.ownerId).toBe(77)
    expect(params.deadline).toBe('2026-06-26T00:00:00.000Z')
    expect(params.responsibleId).toBe(5)
    expect(params.title).toContain('Приход')
    expect(params.description).toContain(activityOriginToken(makeItem()))
  })

  it('omits responsibleId when the company has no assignee', () => {
    const params = buildTodoActivity(makeItem(), { id: 77 })
    expect(params.responsibleId).toBeUndefined()
  })
})
