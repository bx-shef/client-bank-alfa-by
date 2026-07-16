import { describe, expect, it } from 'vitest'
import type { StatementItem } from '~/types/statement'
import { dedupKey } from '~/utils/statement'
import { ACTIVITY_ORIGIN, CRM_OWNER_TYPE_COMPANY } from '~/utils/activity'
import {
  ACTIVITY_ORIGINATOR_ID,
  activityOriginId,
  buildConfigurableActivity,
  buildConfigurableLayout
} from '~/utils/configurableActivity'

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

/** Read a body text-block's `value` from the layout DTO. */
function blockValue(layout: Record<string, unknown>, name: string): string {
  const blocks = ((layout.body as Record<string, unknown>).blocks) as Record<string, { properties: { value: string } }>
  return blocks[name]!.properties.value
}

describe('activityOriginId + ACTIVITY_ORIGINATOR_ID (the dedup marker)', () => {
  it('originId is the operation key (account|docId), at parity with dedupKey', () => {
    const it_ = makeItem()
    expect(activityOriginId(it_)).toBe(dedupKey(it_))
    expect(activityOriginId(it_)).toBe('BY80ALFA30121122220090270000|100231')
  })
  it('originatorId is our app namespace (ACTIVITY_ORIGIN)', () => {
    expect(ACTIVITY_ORIGINATOR_ID).toBe(ACTIVITY_ORIGIN)
    expect(ACTIVITY_ORIGINATOR_ID).toBe('ShefClientBankAlfaBy')
  })
})

describe('buildConfigurableActivity', () => {
  it('sets owner, CONFIGURABLE type, open task, TZ-stamped deadline and the marker pair', () => {
    const params = buildConfigurableActivity(makeItem(), { id: 42 })
    expect(params.ownerTypeId).toBe(CRM_OWNER_TYPE_COMPANY)
    expect(params.ownerId).toBe(42)
    expect(params.fields.typeId).toBe('CONFIGURABLE')
    expect(params.fields.completed).toBe(false)
    // deadline re-stamped into the portal timezone (UTC+3), like the todo path (#10).
    expect(params.fields.deadline).toBe('2026-06-26T00:00:00+03:00')
    expect(params.fields.originatorId).toBe(ACTIVITY_ORIGINATOR_ID)
    expect(params.fields.originId).toBe('BY80ALFA30121122220090270000|100231')
  })
  it('omits responsibleId unless the company carries an assignee', () => {
    expect(buildConfigurableActivity(makeItem(), { id: 42 }).fields.responsibleId).toBeUndefined()
    expect(buildConfigurableActivity(makeItem(), { id: 42, assignedById: 7 }).fields.responsibleId).toBe(7)
  })
  it('always carries a non-empty layout (header + body) — API rejects an empty layout', () => {
    const { layout } = buildConfigurableActivity(makeItem(), { id: 42 })
    expect((layout.header as Record<string, unknown>).title).toContain('Приход')
    expect((layout.body as Record<string, unknown>).blocks).toBeDefined()
  })
})

describe('buildConfigurableLayout', () => {
  it('renders the operation details as body text blocks', () => {
    const layout = buildConfigurableLayout(makeItem())
    expect(blockValue(layout, 'purpose')).toBe('Оплата по счёту №541')
    // formatMoney (ru-RU) uses a non-breaking thousands separator → normalize whitespace.
    expect(blockValue(layout, 'amount').replace(/\s/g, ' ')).toBe('Приход: 1 840,00 BYN')
    expect(blockValue(layout, 'document')).toContain('Документ: #541 от 26.06.2026')
    expect(blockValue(layout, 'counterparty')).toContain('Контрагент: ООО «Ромашка»')
    expect(blockValue(layout, 'counterparty')).toContain('УНП: 191234567')
    expect(blockValue(layout, 'counterparty')).toContain('Банк: Альфа-Банк')
  })
  it('shows a расход with the right verb and sign context', () => {
    const layout = buildConfigurableLayout(makeItem({ direction: 'debit', amount: 500 }))
    expect(blockValue(layout, 'amount').replace(/\s/g, ' ')).toBe('Расход: 500,00 BYN')
    expect((layout.header as Record<string, unknown>).title).toContain('Расход')
  })
  it('omits the Банк line when absent', () => {
    const layout = buildConfigurableLayout(makeItem({ counterparty: { name: 'X', unp: '1', account: 'BY2' } }))
    expect(blockValue(layout, 'counterparty')).not.toContain('Банк:')
  })
  it('renders the document line without a number when docNum is absent', () => {
    const layout = buildConfigurableLayout(makeItem({ docNum: undefined }))
    expect(blockValue(layout, 'document')).toBe('Документ от 26.06.2026')
  })
})

describe('BB-neutralization of payer-controlled fields (configurable layout)', () => {
  const evil = makeItem({
    purpose: 'Оплата [url=http://evil]тут[/url]',
    docNum: '5[b]41',
    counterparty: { name: 'ООО [user=1]Ромашка[/user]', unp: '19[1]', account: 'BY[24]X', bank: 'Аль[b]фа' }
  })
  it('neutralizes brackets in purpose/document/counterparty and the header title', () => {
    const layout = buildConfigurableLayout(evil)
    expect(blockValue(layout, 'purpose')).toBe('Оплата ［url=http://evil］тут［/url］')
    expect(blockValue(layout, 'document')).toContain('#5［b］41')
    expect(blockValue(layout, 'counterparty')).toContain('ООО ［user=1］Ромашка［/user］')
    expect(blockValue(layout, 'counterparty')).toContain('УНП: 19［1］')
    expect(blockValue(layout, 'counterparty')).toContain('BY［24］X')
    // no raw external bracket survives anywhere in the rendered blocks
    const all = [
      (layout.header as Record<string, unknown>).title as string,
      blockValue(layout, 'purpose'), blockValue(layout, 'amount'),
      blockValue(layout, 'document'), blockValue(layout, 'counterparty')
    ].join('\n')
    expect(all).not.toMatch(/\[|\]/)
  })
})
