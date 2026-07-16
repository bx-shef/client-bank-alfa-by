import { describe, expect, it } from 'vitest'
import type { StatementItem } from '~/types/statement'
import {
  buildActivityTitle,
  formatIsoDate,
  formatMoney,
  neutralizeBb,
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

describe('neutralizeBb', () => {
  it('replaces BB brackets with full-width lookalikes, leaves plain text', () => {
    expect(neutralizeBb('[url=x]click[/url]')).toBe('［url=x］click［/url］')
    expect(neutralizeBb('Оплата по счёту №541')).toBe('Оплата по счёту №541')
  })
  it('is idempotent (a second pass is a no-op)', () => {
    expect(neutralizeBb(neutralizeBb('[b]hi[/b]'))).toBe(neutralizeBb('[b]hi[/b]'))
  })
})

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
