import { describe, expect, it } from 'vitest'
import type { StatementItem } from '~/types/statement'
import {
  ACTIVITY_ORIGIN,
  CRM_OWNER_TYPE_COMPANY,
  activityOriginToken,
  buildActivityDescription,
  buildActivityTitle,
  buildTodoActivity,
  formatIsoDate,
  formatMoney,
  toPortalDeadline
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

describe('formatMoney', () => {
  it('formats with two fraction digits', () => {
    expect(formatMoney(1840)).toBe(formatMoney(1840.0))
    expect(formatMoney(320.5)).toContain('320')
    expect(formatMoney(320.5)).toMatch(/50$/)
  })
})

describe('formatIsoDate', () => {
  it('renders the date prefix as DD.MM.YYYY without timezone math', () => {
    expect(formatIsoDate('2026-06-26T00:00:00.000Z')).toBe('26.06.2026')
  })
  it('returns the input unchanged when it is not an ISO date', () => {
    expect(formatIsoDate('not-a-date')).toBe('not-a-date')
  })
})

describe('activityOriginToken', () => {
  it('embeds origin + account|docId for dedup search', () => {
    expect(activityOriginToken(makeItem())).toBe(`[${ACTIVITY_ORIGIN}:BY80ALFA30121122220090270000|100231]`)
  })
})

describe('buildActivityTitle', () => {
  it('uses "Приход … от" for credits with formatted amount', () => {
    expect(buildActivityTitle(makeItem({ direction: 'credit' })))
      .toBe(`Приход ${formatMoney(1840)} BYN от ООО «Ромашка»`)
  })
  it('uses "Расход … на" for debits', () => {
    expect(buildActivityTitle(makeItem({ direction: 'debit' })))
      .toBe(`Расход ${formatMoney(1840)} BYN на ООО «Ромашка»`)
  })
})

describe('buildActivityDescription', () => {
  it('keeps blank separator lines between blocks', () => {
    const text = buildActivityDescription(makeItem())
    expect(text).toContain('\n\n') // blocks are separated, not collapsed
  })
  it('includes purpose, formatted amount, counterparty fields and the dedup token', () => {
    const text = buildActivityDescription(makeItem())
    expect(text).toContain('Оплата по счёту №541')
    expect(text).toContain(`Приход: ${formatMoney(1840)} BYN`)
    expect(text).toContain('УНП: 191234567')
    expect(text).toContain('р/сч: BY24X')
    expect(text).toContain(activityOriginToken(makeItem()))
  })
  it('shows the document number when present, plain form when absent', () => {
    expect(buildActivityDescription(makeItem({ docNum: '541' }))).toContain('Документ: #541 от 26.06.2026')
    const noDoc = buildActivityDescription(makeItem({ docNum: undefined }))
    expect(noDoc).toContain('Документ от 26.06.2026')
    expect(noDoc).not.toContain('#')
  })
  it('omits the bank line when the counterparty has no bank', () => {
    const cp = { name: 'X', unp: '1', account: 'BY24X' }
    expect(buildActivityDescription(makeItem({ counterparty: cp }))).not.toContain('Банк:')
  })
  it('inserts the allocation note before the origin marker when provided', () => {
    const note = 'Предпросмотр разнесения: инвойс #7 — точное совпадение суммы'
    const text = buildActivityDescription(makeItem(), note)
    expect(text).toContain(note)
    // note sits before the dedup token (owner reads it inline with the operation)
    expect(text.indexOf(note)).toBeLessThan(text.indexOf(activityOriginToken(makeItem())))
  })
  it('leaves the description unchanged for a blank/whitespace note', () => {
    const base = buildActivityDescription(makeItem())
    expect(buildActivityDescription(makeItem(), '')).toBe(base)
    expect(buildActivityDescription(makeItem(), '   ')).toBe(base)
  })
})

describe('toPortalDeadline', () => {
  it('re-stamps a bare UTC midnight to the portal offset (+03:00), same calendar day', () => {
    expect(toPortalDeadline('2026-07-01T00:00:00.000Z')).toBe('2026-07-01T00:00:00+03:00')
  })
  it('stamps a bare date at portal-local start of day', () => {
    expect(toPortalDeadline('2026-07-01')).toBe('2026-07-01T00:00:00+03:00')
  })
  it('keeps a naive local datetime and appends the offset', () => {
    expect(toPortalDeadline('2026-07-01T12:30:00')).toBe('2026-07-01T12:30:00+03:00')
  })
  it('pads an HH:MM time to HH:MM:SS', () => {
    expect(toPortalDeadline('2026-07-01T09:05')).toBe('2026-07-01T09:05:00+03:00')
  })
  it('passes an unrecognized value through unchanged', () => {
    expect(toPortalDeadline('')).toBe('')
    expect(toPortalDeadline('not-a-date')).toBe('not-a-date')
  })
})

describe('buildTodoActivity', () => {
  it('binds to the company and carries acceptDate as the required deadline', () => {
    const params = buildTodoActivity(makeItem({ operDate: '2026-07-01T00:00:00.000Z' }), { id: 77, assignedById: 5 })
    expect(params.ownerTypeId).toBe(CRM_OWNER_TYPE_COMPANY)
    expect(params.ownerId).toBe(77)
    // deadline is the acceptance date (never operDate), re-stamped into portal TZ (#10).
    expect(params.deadline).toBe('2026-06-26T00:00:00+03:00')
    expect(params.responsibleId).toBe(5)
    expect(params.title).toContain('Приход')
  })

  it('omits responsibleId when the company has no (or zero) assignee', () => {
    expect(buildTodoActivity(makeItem(), { id: 77 }).responsibleId).toBeUndefined()
    expect(buildTodoActivity(makeItem(), { id: 77, assignedById: 0 }).responsibleId).toBeUndefined()
  })
})
