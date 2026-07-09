import { describe, expect, it } from 'vitest'
import {
  DEMO_MATRICES,
  demoAlfaExtraction,
  demoAlfaResponse,
  demoPriorExtraction,
  demoPriorResponse,
  summarizeExtraction
} from '~/utils/demoExtract'
import { normalizeAlfa } from '~/utils/alfaStatement'
import type { StatementItem } from '~/types/statement'

function item(partial: Partial<StatementItem>): StatementItem {
  return {
    account: 'BY80ALFA30121122220090270000',
    docId: '1',
    direction: 'credit',
    amount: 100,
    currency: 'BYN',
    purpose: '',
    counterparty: { name: '', unp: '', account: '' },
    acceptDate: '2026-06-26T00:00:00.000Z',
    ...partial
  }
}

describe('summarizeExtraction', () => {
  it('counts operations, directions and unique counterparties', () => {
    const s = summarizeExtraction([
      item({ docId: '1', direction: 'credit', amount: 100, counterparty: { name: 'A', unp: '111', account: 'x' } }),
      item({ docId: '2', direction: 'debit', amount: 40, counterparty: { name: 'B', unp: '222', account: 'y' } }),
      // Same counterparty (same УНП) as the first → not double-counted.
      item({ docId: '3', direction: 'credit', amount: 60, counterparty: { name: 'A again', unp: '111', account: 'z' } })
    ])
    expect(s.operationCount).toBe(3)
    expect(s.creditCount).toBe(2)
    expect(s.debitCount).toBe(1)
    expect(s.counterpartyCount).toBe(2)
  })

  it('handles an empty statement without throwing', () => {
    const s = summarizeExtraction([])
    expect(s.operationCount).toBe(0)
    expect(s.creditCount).toBe(0)
    expect(s.debitCount).toBe(0)
    expect(s.counterpartyCount).toBe(0)
    expect(s.totals).toEqual([])
    expect(s.recognized).toEqual([])
  })

  it('does not count a counterparty with no УНП/account/name', () => {
    const s = summarizeExtraction([
      item({ docId: '1', counterparty: { name: '', unp: '', account: '' } })
    ])
    expect(s.operationCount).toBe(1)
    expect(s.counterpartyCount).toBe(0)
  })

  it('rounds per-currency totals to 2 decimals (no float drift)', () => {
    const s = summarizeExtraction([
      item({ docId: '1', direction: 'credit', amount: 0.1, currency: 'BYN' }),
      item({ docId: '2', direction: 'credit', amount: 0.2, currency: 'BYN' })
    ])
    // 0.1 + 0.2 === 0.30000000000000004 without rounding.
    expect(s.totals[0]!.credit).toBe(0.3)
  })

  it('totals money per currency', () => {
    const s = summarizeExtraction([
      item({ docId: '1', direction: 'credit', amount: 100, currency: 'BYN' }),
      item({ docId: '2', direction: 'debit', amount: 30, currency: 'BYN' }),
      item({ docId: '3', direction: 'credit', amount: 500, currency: 'RUB' })
    ])
    const byn = s.totals.find(t => t.currency === 'BYN')!
    const rub = s.totals.find(t => t.currency === 'RUB')!
    expect(byn.credit).toBe(100)
    expect(byn.debit).toBe(30)
    expect(rub.credit).toBe(500)
    expect(rub.debit).toBe(0)
  })

  it('recognizes identifiers in the purpose via the demo matrices', () => {
    const s = summarizeExtraction([
      item({ docId: '1', purpose: 'Оплата по счёту СЧ-1042 за услуги' }),
      item({ docId: '2', purpose: 'Просто перевод без номера' }),
      item({ docId: '3', purpose: 'Предоплата по заказу ЗК-2050' })
    ])
    // Only the two operations with a recognizable identifier appear.
    expect(s.recognized).toHaveLength(2)
    const first = s.recognized.find(r => r.docId === '1')!
    expect(first.ids[0]).toEqual({ kind: 'invoice-number', value: 'СЧ-1042' })
    const third = s.recognized.find(r => r.docId === '3')!
    expect(third.ids[0]).toEqual({ kind: 'order-number', value: 'ЗК-2050' })
  })

  it('has demo matrices covering invoice, order and document kinds', () => {
    const kinds = DEMO_MATRICES.map(m => m.kind)
    expect(kinds).toContain('invoice-number')
    expect(kinds).toContain('order-number')
    expect(kinds).toContain('document-number')
  })
})

describe('bank sandbox demos run through the real normalizers', () => {
  it('Alfa sample normalizes and extracts', () => {
    // The demo must go through the SAME normalizer the backend uses.
    const viaNormalizer = normalizeAlfa(demoAlfaResponse(), { account: 'BY80ALFA30121122220090270000' })
    const s = demoAlfaExtraction()
    expect(s.items).toEqual(viaNormalizer)
    expect(s.operationCount).toBe(3)
    expect(s.creditCount).toBe(2)
    expect(s.debitCount).toBe(1)
    // Alfa sample carries an invoice number and an order number in its purposes.
    const recognizedKinds = s.recognized.flatMap(r => r.ids.map(i => i.kind))
    expect(recognizedKinds).toContain('invoice-number')
    expect(recognizedKinds).toContain('order-number')
  })

  it('Prior sample normalizes with correct direction and counterparty side', () => {
    const s = demoPriorExtraction()
    expect(s.operationCount).toBe(2)
    expect(s.creditCount).toBe(1)
    expect(s.debitCount).toBe(1)
    // Credit → counterparty is the debtor (payer); Debit → the creditor (payee).
    const credit = s.items.find(i => i.direction === 'credit')!
    expect(credit.counterparty.name).toBe('ЗАО «Вектор»')
    expect(credit.counterparty.unp).toBe('192887711') // digits kept from INN192887711
    const debit = s.items.find(i => i.direction === 'debit')!
    expect(debit.counterparty.name).toBe('СООО «Компания Связи»')
    // Prior sample carries an invoice number and a document number.
    const recognizedKinds = s.recognized.flatMap(r => r.ids.map(i => i.kind))
    expect(recognizedKinds).toContain('invoice-number')
    expect(recognizedKinds).toContain('document-number')
  })

  it('demoPriorResponse is a well-formed transaction-list shape', () => {
    expect(demoPriorResponse().data?.transaction).toHaveLength(2)
  })
})
