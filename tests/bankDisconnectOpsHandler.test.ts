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
  consentExpiresAt: 0, accountConfirmedAt: 0, pollPaused: false, grantId: '', ...over
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

describe('портал с мёртвой подпиской (#614)', () => {
  // ⚠ Гейт «только нерабочее» здесь НЕДОСТАТОЧЕН: у портала с истёкшей подпиской банковское
  // подключение бывает совершенно живым — сломана оплата Битрикса, а не доступ к счёту. Без этой
  // ветки оператор не смог бы отключить ровно тот случай, ради которого раздел и заведён: клиент
  // до приложения не доберётся (оно открывается ВНУТРИ неработающего Битрикса) и сам не отключит.

  /** Подключение, у которого с БАНКОМ всё в порядке. */
  const liveRow = (over: Partial<BankAccountInfo> = {}): BankAccountInfo => ({
    id: 9, memberId: 'M2', provider: 'alfa-by', accountKey: 'BY02',
    connectedAt: NOW - 60_000, expiresAt: NOW + 3_600_000, hasRefresh: true, lastAttemptAt: 0,
    consentExpiresAt: 0, accountConfirmedAt: 0, pollPaused: false, grantId: '', ...over
  })

  it('живое подключение + мёртвая подписка ⇒ отключаем, причина НЕ банковская', async () => {
    const { d, notified } = deps({
      getRow: async () => liveRow(),
      subscriptionEndedAt: async () => NOW - 5 * DAY
    })
    const r = await handleOpsBankDisconnect(d, 9)
    expect(r.status).toBe(200)
    // ⚠ Именно `subscription-ended`: сказать «банк перестал продлевать» значило бы отправить
    // бухгалтера в банк разбираться с тем, что чинится оплатой подписки.
    expect(notified).toEqual(['9|subscription-ended'])
  })

  it('живое подключение + ЖИВАЯ подписка ⇒ по-прежнему 409', async () => {
    // Главный инвариант всего гейта: импорт живого клиента из операторской не обрывается.
    const remove = vi.fn(async () => 'removed' as const)
    const { d } = deps({ getRow: async () => liveRow(), subscriptionEndedAt: async () => 0, remove })
    const r = await handleOpsBankDisconnect(d, 9)
    expect(r.status).toBe(409)
    expect(remove, 'живое подключение не должно удаляться').not.toHaveBeenCalled()
  })

  it('без проводки проверки подписки ведёт себя как раньше', async () => {
    // Зависимость необязательная: забыли прокинуть — гейт остаётся прежним, а не открывается.
    const remove = vi.fn(async () => 'removed' as const)
    const { d } = deps({ getRow: async () => liveRow(), remove })
    const r = await handleOpsBankDisconnect(d, 9)
    expect(r.status).toBe(409)
    expect(remove).not.toHaveBeenCalled()
  })

  it('НЕРАБОЧЕЕ подключение банка не переклассифицируется в подписку', async () => {
    // Причина банка приоритетнее: она точнее описывает, что чинить, и подписку даже не спрашиваем.
    const subSpy = vi.fn(async () => NOW - 9 * DAY)
    const { d, notified } = deps({ subscriptionEndedAt: subSpy })
    const r = await handleOpsBankDisconnect(d, 7)
    expect(r.status).toBe(200)
    expect(notified).toEqual(['7|refresh-dead'])
    expect(subSpy, 'лишний запрос в базу при уже известной причине').not.toHaveBeenCalled()
  })
})
