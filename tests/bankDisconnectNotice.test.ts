import { describe, expect, it } from 'vitest'
import { bankDisconnectReason, buildBankDisconnectNotice } from '../app/utils/bankDisconnectNotice'
import { BANK_REFRESH_TTL_SEC } from '../app/utils/bankTokenLifetime'

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const ALFA_TTL = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000

describe('bankDisconnectReason (#599)', () => {
  it('истёкшее согласие перекрывает всё — consent-expired', () => {
    expect(bankDisconnectReason({ provider: 'prior-by', connectedAt: NOW, hasRefresh: true, consentExpiresAt: NOW - DAY }, NOW))
      .toBe('consent-expired')
  })
  it('нет токена продления — no-refresh', () => {
    expect(bankDisconnectReason({ provider: 'prior-by', connectedAt: NOW, hasRefresh: false }, NOW)).toBe('no-refresh')
  })
  it('Альфа старше измеренного TTL — refresh-dead', () => {
    expect(bankDisconnectReason({ provider: 'alfa-by', connectedAt: NOW - ALFA_TTL - DAY, hasRefresh: true }, NOW))
      .toBe('refresh-dead')
  })
  it('Приор по догадке о сроке — НЕ причина (живо)', () => {
    expect(bankDisconnectReason({ provider: 'prior-by', connectedAt: NOW - 300 * DAY, hasRefresh: true }, NOW)).toBeNull()
  })
  it('свежее подключение — null', () => {
    expect(bankDisconnectReason({ provider: 'alfa-by', connectedAt: NOW - 3_600_000, hasRefresh: true }, NOW)).toBeNull()
  })
})

describe('buildBankDisconnectNotice — клиенту, без упоминания оператора (#599)', () => {
  it('называет банк, счёт и что делать', () => {
    const m = buildBankDisconnectNotice('alfa-by', 'BY12ALFA0001', 'refresh-dead')
    expect(m).toContain('BY12ALFA0001')
    expect(m).toContain('Альфа-Банк')
    expect(m).toContain('переподключите')
  })
  it('НЕ говорит, что отключил оператор/вручную — не нервируем клиента', () => {
    for (const r of ['consent-expired', 'refresh-dead', 'no-refresh'] as const) {
      const m = buildBankDisconnectNotice('prior-by', 'BY01', r)
      expect(m.toLowerCase()).not.toContain('оператор')
      expect(m.toLowerCase()).not.toContain('вручную')
    }
  })
  it('у каждой причины свой текст', () => {
    const set = new Set(['consent-expired', 'refresh-dead', 'no-refresh'].map(r =>
      buildBankDisconnectNotice('alfa-by', 'BY01', r as never)))
    expect(set.size).toBe(3)
  })
})
