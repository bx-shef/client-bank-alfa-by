import { describe, expect, it } from 'vitest'
import { buildDeletionErrorMessage } from '~/utils/deletionErrorMessage'

// Pure deletion error-chat message builder (#109 §9.2/§5). PII-free: only kind + id (+ freed count).

describe('buildDeletionErrorMessage', () => {
  it('company deletion → «потерян ответственный» notice with the id', () => {
    const msg = buildDeletionErrorMessage('company', '7')!
    expect(msg).toContain('Удалена компания')
    expect(msg).toContain('#7')
    expect(msg).toContain('переназначьте вручную')
  })

  it('payment-carrier → structure-damaged notice', () => {
    const msg = buildDeletionErrorMessage('payment-carrier', '100')!
    expect(msg).toContain('Повреждена структура распределения')
    expect(msg).toContain('#100')
  })

  it('target (invoice) with freed count → «освобождено распределений: N»', () => {
    const msg = buildDeletionErrorMessage('invoice', '39', { freed: 2 })!
    expect(msg).toContain('Удалена цель разнесения')
    expect(msg).toContain('смарт-счёт #39')
    expect(msg).toContain('Освобождено распределений: 2')
    expect(msg).toContain('требуют повторного распределения')
  })

  it('deal target without a freed count → omits the count line detail', () => {
    const msg = buildDeletionErrorMessage('deal', '15')!
    expect(msg).toContain('сделка #15')
    expect(msg).not.toContain('Освобождено распределений')
  })

  it('ignores a non-positive / non-integer freed count', () => {
    expect(buildDeletionErrorMessage('invoice', '1', { freed: 0 })).not.toContain('Освобождено')
    expect(buildDeletionErrorMessage('invoice', '1', { freed: -3 })).not.toContain('Освобождено')
  })

  it('carries NO amounts / accounts / counterparty (privacy §9.2)', () => {
    const msg = buildDeletionErrorMessage('invoice', '39', { freed: 2 })!
    expect(msg).not.toMatch(/BYN|USD|EUR|\d+[.,]\d{2}/) // no money
  })

  it('neutralizes BB-code in a (hypothetical non-digit) id — no injection', () => {
    const msg = buildDeletionErrorMessage('company', '[b]x[/b]')!
    expect(msg).not.toContain('[b]x[/b]') // the injected tags are neutralized
    expect(msg).toContain('Удалена компания')
  })
})
