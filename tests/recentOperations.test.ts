import { describe, expect, it } from 'vitest'
import {
  buildRecentOperationsListCall,
  mapRecentOperations,
  paymentElementToStatementItem
} from '~/utils/recentOperations'
import { PAYMENT_SP_FIELDS, buildUfFieldNameCamel, type SpRef } from '~/config/distributionSp'

// «Последние операции» (#5/#36) — обратный маппинг элементов СП «Платежи» в StatementItem для
// витрины. Проверяется прежде всего, что данные разворачиваются ВЕРНО (направление, сумма,
// контрагент) и что чужой/битый элемент не показывается нулём.

const SP: SpRef = { entityTypeId: 1044, id: 3 }
const uf = (postfix: string) => buildUfFieldNameCamel(SP.id, postfix)

/** Элемент СП с нашими полями реестра — ключи строим тем же билдером, что и продакшн. */
function element(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '10',
    [uf(PAYMENT_SP_FIELDS.total.postfix)]: 450,
    [uf(PAYMENT_SP_FIELDS.currency.postfix)]: 'BYN',
    [uf(PAYMENT_SP_FIELDS.operationDate.postfix)]: '2026-08-21',
    [uf(PAYMENT_SP_FIELDS.direction.postfix)]: 'Приход',
    [uf(PAYMENT_SP_FIELDS.counterparty.postfix)]: 'ООО Ромашка',
    [uf(PAYMENT_SP_FIELDS.counterpartyAccount.postfix)]: 'BY99PAYER0001',
    [uf(PAYMENT_SP_FIELDS.counterpartyUnp.postfix)]: '191',
    [uf(PAYMENT_SP_FIELDS.purpose.postfix)]: 'оплата по счёту',
    [uf(PAYMENT_SP_FIELDS.ownAccount.postfix)]: 'BY01ALFA',
    [uf(PAYMENT_SP_FIELDS.marker.postfix)]: 'BY01ALFA|D42',
    ...over
  }
}

describe('paymentElementToStatementItem', () => {
  it('разворачивает элемент реестра в операцию (все поля)', () => {
    const item = paymentElementToStatementItem(element(), SP)
    expect(item).toEqual({
      account: 'BY01ALFA',
      docId: 'D42',
      direction: 'credit',
      amount: 450,
      currency: 'BYN',
      purpose: 'оплата по счёту',
      acceptDate: '2026-08-21',
      counterparty: { name: 'ООО Ромашка', unp: '191', account: 'BY99PAYER0001' }
    })
  })

  it('«Расход» → debit, «Приход» и всё прочее → credit', () => {
    expect(paymentElementToStatementItem(element({ [uf(PAYMENT_SP_FIELDS.direction.postfix)]: 'Расход' }), SP)!.direction).toBe('debit')
    expect(paymentElementToStatementItem(element({ [uf(PAYMENT_SP_FIELDS.direction.postfix)]: 'Приход' }), SP)!.direction).toBe('credit')
    expect(paymentElementToStatementItem(element({ [uf(PAYMENT_SP_FIELDS.direction.postfix)]: '' }), SP)!.direction).toBe('credit')
  })

  it('элемент без валидной положительной суммы — не наша строка реестра → null (не нулём)', () => {
    expect(paymentElementToStatementItem(element({ [uf(PAYMENT_SP_FIELDS.total.postfix)]: 'мусор' }), SP)).toBeNull()
    expect(paymentElementToStatementItem(element({ [uf(PAYMENT_SP_FIELDS.total.postfix)]: undefined }), SP)).toBeNull()
    expect(paymentElementToStatementItem(element({ [uf(PAYMENT_SP_FIELDS.total.postfix)]: 0 }), SP)).toBeNull()
    expect(paymentElementToStatementItem(element({ [uf(PAYMENT_SP_FIELDS.total.postfix)]: null }), SP)).toBeNull()
  })

  it('docId из маркера: <счёт>|<docId>, а хеш-сигнатуру пустого docId не берём', () => {
    expect(paymentElementToStatementItem(element({ [uf(PAYMENT_SP_FIELDS.marker.postfix)]: 'BY01ALFA|~sig:abcdef' }), SP)!.docId).toBe('')
    expect(paymentElementToStatementItem(element({ [uf(PAYMENT_SP_FIELDS.marker.postfix)]: 'кривой' }), SP)!.docId).toBe('')
  })

  it('дата берётся календарной частью, даже если портал отдал с временем', () => {
    const item = paymentElementToStatementItem(element({ [uf(PAYMENT_SP_FIELDS.operationDate.postfix)]: '2026-08-21T00:00:00+03:00' }), SP)
    expect(item!.acceptDate).toBe('2026-08-21')
  })

  it('банк контрагента НЕ подставляется из поля «наш банк» реестра', () => {
    // В реестре поле bank — наш провайдер (Альфа/Приор), а не банк плательщика.
    const item = paymentElementToStatementItem(element(), SP)
    expect(item!.counterparty.bank).toBeUndefined()
  })
})

describe('mapRecentOperations', () => {
  it('разворачивает страницу и отбрасывает битые элементы', () => {
    const rows = [element({ id: '1' }), element({ id: '2', [uf(PAYMENT_SP_FIELDS.total.postfix)]: null }), element({ id: '3' })]
    const ops = mapRecentOperations(rows, SP)
    expect(ops).toHaveLength(2) // средний (без суммы) отброшен
  })
})

describe('buildRecentOperationsListCall', () => {
  it('свежие сверху, первая страница, select:[*] для всех полей (#41)', () => {
    const call = buildRecentOperationsListCall(SP)
    expect(call.method).toBe('crm.item.list')
    expect(call.params.entityTypeId).toBe(1044)
    expect(call.params.order).toEqual({ id: 'DESC' })
    expect(call.params.start).toBe(0)
    // ⚠ `select: ['*']`, а не перечень полей: явный select недавно добавленных UF-полей СП на живом
    // портале не возвращал поля реестра #575 (см. комментарий в recentOperations.ts). По документации
    // `'*'` отдаёт ВСЕ поля, включая UF; опускать select нельзя — UF-поля тогда не гарантированы.
    expect(call.params.select).toEqual(['*'])
  })
})
