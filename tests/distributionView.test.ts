import { describe, expect, it } from 'vitest'
import { presentPaymentLedger, targetLabel } from '~/utils/distributionView'
import type { DistributionEntry } from '~/utils/manualAllocation'

// Pure presentational core for the «Распределение» card (#109 §9.3 #4). No DOM.

const row = (over: Partial<DistributionEntry> = {}): DistributionEntry => ({
  targetKind: 'invoice', targetId: '39', amount: 30, currency: 'BYN', source: 'auto', status: 'active', ...over
})

describe('targetLabel', () => {
  it('is «<kind RU> #<id>»', () => {
    expect(targetLabel('invoice', '39')).toBe('смарт-счёт #39')
    expect(targetLabel('deal-payment', '7')).toBe('оплата сделки #7')
    expect(targetLabel('deal', '1')).toBe('сделка #1')
    expect(targetLabel('smart-process', '5')).toBe('смарт-процесс #5')
  })
})

describe('presentPaymentLedger', () => {
  it('computes distributed / remaining / overLimit and formats money with the currency', () => {
    const v = presentPaymentLedger(100, 'BYN', [row({ amount: 30 }), row({ targetId: '40', amount: 20 })])
    expect(v.distributed).toBe(50)
    expect(v.remaining).toBe(50)
    expect(v.overLimit).toBe(false)
    expect(v.totalText).toContain('BYN')
    expect(v.remainingText).toContain('BYN')
    expect(v.rows).toHaveLength(2)
    expect(v.rows[0]!.label).toBe('смарт-счёт #39')
    expect(v.rows[0]!.amountText).toContain('BYN')
    expect(v.rows[0]!.active).toBe(true)
  })

  it('a reverted row is kept but does not count toward distributed and is inactive', () => {
    const v = presentPaymentLedger(100, 'BYN', [row({ amount: 30 }), row({ targetId: '40', amount: 20, status: 'reverted' })])
    expect(v.distributed).toBe(30) // reverted freed
    expect(v.remaining).toBe(70)
    expect(v.rows[1]!.active).toBe(false)
    expect(v.rows[1]!.status).toBe('reverted')
  })

  it('flags over-limit when active distributions exceed the total', () => {
    const v = presentPaymentLedger(100, 'BYN', [row({ amount: 150 })])
    expect(v.overLimit).toBe(true)
    expect(v.remaining).toBe(0) // never negative
  })

  it('empty ledger → nothing distributed, remaining = full', () => {
    const v = presentPaymentLedger(100, 'BYN', [])
    expect(v.distributed).toBe(0)
    expect(v.remaining).toBe(100)
    expect(v.rows).toEqual([])
  })

  it('formats money without a trailing space when currency is blank', () => {
    const v = presentPaymentLedger(100, '', [])
    expect(v.totalText).not.toMatch(/\s$/)
  })
})
