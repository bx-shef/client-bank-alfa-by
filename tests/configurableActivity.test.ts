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

/* eslint-disable @typescript-eslint/no-explicit-any */
function body(layout: Record<string, unknown>): Record<string, any> {
  return (layout.body as any).blocks as Record<string, any>
}
/** Read a body block's displayed value: `text` → properties.value; `withTitle` → nested text value. */
function blockValue(layout: Record<string, unknown>, name: string): string {
  const b = body(layout)[name]!
  return b.type === 'withTitle' ? b.properties.block.properties.value : b.properties.value
}
/** Read a `withTitle` block's label. */
function blockTitle(layout: Record<string, unknown>, name: string): string {
  return body(layout)[name]!.properties.title
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
  it('renders the operation details: purpose text + withTitle field rows', () => {
    const layout = buildConfigurableLayout(makeItem())
    expect(blockValue(layout, 'purpose')).toBe('Оплата по счёту №541')
    // amount is a withTitle row: label = направление, value = сумма (non-breaking sep → normalize)
    expect(blockTitle(layout, 'amount')).toBe('Приход')
    expect(blockValue(layout, 'amount').replace(/\s/g, ' ')).toBe('1 840,00 BYN')
    expect(blockTitle(layout, 'document')).toBe('Документ')
    expect(blockValue(layout, 'document')).toBe('#541 от 26.06.2026')
    expect(blockValue(layout, 'counterparty')).toBe('ООО «Ромашка»')
    expect(blockValue(layout, 'unp')).toBe('191234567')
    expect(blockValue(layout, 'account')).toBe('BY24X')
    expect(blockValue(layout, 'bank')).toBe('Альфа-Банк')
  })
  it('shows a расход with the right verb in the header and the amount label', () => {
    const layout = buildConfigurableLayout(makeItem({ direction: 'debit', amount: 500 }))
    expect(blockTitle(layout, 'amount')).toBe('Расход')
    expect(blockValue(layout, 'amount').replace(/\s/g, ' ')).toBe('500,00 BYN')
    expect((layout.header as Record<string, unknown>).title).toContain('Расход')
  })
  it('omits the bank block when the counterparty has no bank', () => {
    const layout = buildConfigurableLayout(makeItem({ counterparty: { name: 'X', unp: '1', account: 'BY2' } }))
    expect(body(layout).bank).toBeUndefined()
  })
  it('renders the document value without a number when docNum is absent', () => {
    const layout = buildConfigurableLayout(makeItem({ docNum: undefined }))
    expect(blockValue(layout, 'document')).toBe('от 26.06.2026')
  })
  it('uses valid ContentBlockDto types (text / withTitle wrapping text) + required body.logo', () => {
    const layout = buildConfigurableLayout(makeItem())
    const blocks = body(layout)
    expect(blocks.purpose.type).toBe('text')
    expect(blocks.amount.type).toBe('withTitle')
    expect(blocks.amount.properties.block.type).toBe('text')
    // BodyDto marks `logo` required — a valid system code must be present.
    expect(((layout.body as Record<string, unknown>).logo as { code?: string }).code).toBe('notification')
  })
})

describe('BB-neutralization of payer-controlled fields (configurable layout)', () => {
  const evil = makeItem({
    purpose: 'Оплата [url=http://evil]тут[/url]',
    docNum: '5[b]41',
    counterparty: { name: 'ООО [user=1]Ромашка[/user]', unp: '19[1]', account: 'BY[24]X', bank: 'Аль[b]фа' }
  })
  it('neutralizes brackets in every payer-controlled field and the header title', () => {
    const layout = buildConfigurableLayout(evil)
    expect(blockValue(layout, 'purpose')).toBe('Оплата ［url=http://evil］тут［/url］')
    expect(blockValue(layout, 'document')).toContain('#5［b］41')
    expect(blockValue(layout, 'counterparty')).toBe('ООО ［user=1］Ромашка［/user］')
    expect(blockValue(layout, 'unp')).toBe('19［1］')
    expect(blockValue(layout, 'account')).toBe('BY［24］X')
    expect(blockValue(layout, 'bank')).toBe('Аль［b］фа')
    // no raw external bracket survives anywhere in the rendered blocks (labels are our own)
    const all = ['purpose', 'amount', 'document', 'counterparty', 'unp', 'account', 'bank']
      .map(n => blockValue(layout, n))
      .concat((layout.header as Record<string, unknown>).title as string)
      .join('\n')
    expect(all).not.toMatch(/\[|\]/)
  })
})
