import { describe, expect, it, vi } from 'vitest'
import { handleOpsBankDisconnect, type BankDisconnectOpsDeps } from '../server/utils/bankDisconnectOpsHandler'
import type { BankAccountInfo } from '../server/utils/bankTokenStore'
import { BANK_REFRESH_TTL_SEC } from '../app/utils/bankTokenLifetime'

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const ALFA_TTL = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000

const deadRow = (over: Partial<BankAccountInfo> = {}): BankAccountInfo => ({
  id: 7, memberId: 'M1', provider: 'alfa-by', accountKey: 'BY01',
  connectedAt: NOW - ALFA_TTL - 40 * DAY, expiresAt: NOW, hasRefresh: true, lastAttemptAt: 0,
  consentExpiresAt: 0, pollPaused: false, grantId: '', ...over
})

function deps(over: Partial<BankDisconnectOpsDeps> = {}) {
  const notified: string[] = []
  const d: BankDisconnectOpsDeps = {
    now: () => NOW,
    getRow: async () => deadRow(),
    remove: async () => 'removed',
    notify: async (row, reason) => { notified.push(`${row.id}|${reason}`) },
    ...over
  }
  return { d, notified }
}

describe('handleOpsBankDisconnect (#599)', () => {
  it('нерабочее подключение: удаляет, потом шлёт пометку', async () => {
    const remove = vi.fn(async () => 'removed' as const)
    const { d, notified } = deps({ remove })
    const r = await handleOpsBankDisconnect(d, 7)
    expect(r.status).toBe(200)
    expect(remove).toHaveBeenCalledWith('M1', 7, 'BY01')
    expect(notified).toEqual(['7|refresh-dead'])
  })

  it('РАБОЧЕЕ подключение из операторской НЕ отключаем — 409, ничего не трогаем', async () => {
    // ⚠ Гейт. Иначе это способ тихо оборвать импорт живого клиента.
    const remove = vi.fn(async () => 'removed' as const)
    const { d, notified } = deps({ getRow: async () => deadRow({ connectedAt: NOW - 3_600_000 }), remove })
    const r = await handleOpsBankDisconnect(d, 7)
    expect(r.status).toBe(409)
    expect(remove).not.toHaveBeenCalled()
    expect(notified).toEqual([])
  })

  it('пометка шлётся ТОЛЬКО после успешного удаления (порядок)', async () => {
    // gone/stale → мы ничего не отключили → пометку НЕ шлём (иначе соврём клиенту).
    const notify = vi.fn(async () => {})
    const { d } = deps({ remove: async () => 'stale', notify })
    const r = await handleOpsBankDisconnect(d, 7)
    expect(r.status).toBe(409)
    expect(notify).not.toHaveBeenCalled()
  })

  it('строки нет — 404', async () => {
    const r = await handleOpsBankDisconnect(deps({ getRow: async () => null }).d, 7)
    expect(r.status).toBe(404)
  })

  it('кривой id — 400 без обращения к базе', async () => {
    const getRow = vi.fn(async () => null)
    for (const bad of [0, -1, 'x', undefined, 1.5]) {
      expect((await handleOpsBankDisconnect(deps({ getRow }).d, bad)).status).toBe(400)
    }
    expect(getRow).not.toHaveBeenCalled()
  })
})
