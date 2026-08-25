import { describe, expect, it, vi } from 'vitest'
import { runBankReaper, type BankReaperDeps } from '../server/utils/bankReaperRun'
import type { BankAccountInfo } from '../server/utils/bankTokenStore'
import { BANK_REFRESH_TTL_SEC } from '../app/utils/bankTokenLifetime'
import { provisionalAccountKey } from '../app/utils/bankAccountKey'

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const ALFA_TTL = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000

function acc(over: Partial<BankAccountInfo> = {}): BankAccountInfo {
  return {
    id: 1, memberId: 'M1', provider: 'alfa-by', accountKey: 'BY01',
    connectedAt: NOW - 60_000, expiresAt: NOW, hasRefresh: true, lastAttemptAt: 0,
    consentExpiresAt: 0, accountConfirmedAt: 0, pollPaused: false, grantId: '', ...over
  }
}

/** Измеренно-мёртвая Альфа: старше TTL на `days` дней. */
function deadAlfa(over: Partial<BankAccountInfo> = {}, deadDays = 40): BankAccountInfo {
  return acc({ connectedAt: NOW - ALFA_TTL - deadDays * DAY, ...over })
}

function deps(rows: BankAccountInfo[], over: Partial<BankReaperDeps> = {}): { d: BankReaperDeps, removed: string[] } {
  const removed: string[] = []
  const d: BankReaperDeps = {
    now: () => NOW,
    listAccounts: async () => rows,
    remove: async (memberId, id, key) => {
      removed.push(`${memberId}|${id}|${key}`)
      return 'removed'
    },
    ...over
  }
  return { d, removed }
}

describe('runBankReaper (#599)', () => {
  it('стирает измеренно-мёртвую строку старше порога', async () => {
    const { d, removed } = deps([deadAlfa({ id: 7 })])
    const s = await runBankReaper(d, 30)
    expect(s.candidates).toBe(1)
    expect(s.reaped).toBe(1)
    expect(removed).toEqual(['M1|7|BY01'])
  })

  it('НЕ трогает Приор с угаданным сроком, как бы стар он ни был', async () => {
    // ⚠ Главный инвариант: догадка о сроке refresh не хоронит. Только дата банка (согласие).
    const { d, removed } = deps([acc({ provider: 'prior-by', connectedAt: NOW - 300 * DAY, id: 9 })])
    const s = await runBankReaper(d, 30)
    expect(s.candidates).toBe(0)
    expect(removed).toEqual([])
  })

  it('Приор с ИСТЁКШИМ согласием — стирается (дата банка)', async () => {
    const { d } = deps([acc({ provider: 'prior-by', consentExpiresAt: NOW - 40 * DAY, id: 3 })])
    expect((await runBankReaper(d, 30)).reaped).toBe(1)
  })

  it('недавно умершую — НЕ трогает (порог не прошёл)', async () => {
    const { d } = deps([deadAlfa({}, 5)])
    const s = await runBankReaper(d, 30)
    expect(s.candidates).toBe(0)
    expect(s.reaped).toBe(0)
  })

  it('ожидающие подключения (~pending:) пропускает целиком', async () => {
    const { d } = deps([deadAlfa({ accountKey: provisionalAccountKey('n1'), consentExpiresAt: NOW - 40 * DAY })])
    expect((await runBankReaper(d, 30)).candidates).toBe(0)
  })

  it('потолок за прогон: стирает не больше MAX, самые давние первыми', async () => {
    const dead = [
      deadAlfa({ id: 1 }, 20),
      deadAlfa({ id: 2 }, 60), // самая давняя
      deadAlfa({ id: 3 }, 40),
      deadAlfa({ id: 4 }, 50),
      deadAlfa({ id: 5 }, 45),
      deadAlfa({ id: 6 }, 35)
    ]
    // ⚠ Живые строки нужны, чтобы 6 мёртвых не сработали как предохранитель по доле флота (>34%).
    const live = Array.from({ length: 14 }, (_, i) => acc({ id: 100 + i }))
    const { d, removed } = deps([...dead, ...live])
    const s = await runBankReaper(d, 15)
    expect(s.reaped).toBe(5)
    expect(s.capped).toBe(true)
    // Не стёртая — самая «молодая» из мёртвых (id 1, 20 дней).
    expect(removed.map(r => r.split('|')[1])).not.toContain('1')
  })

  it('предохранитель: измеренно-мёртвых слишком большая доля — не стираем НИЧЕГО', async () => {
    // 4 из 5 мертвы → доля 0.8 > 0.34 → это мы, а не клиенты.
    const rows = [
      deadAlfa({ id: 1 }), deadAlfa({ id: 2 }), deadAlfa({ id: 3 }), deadAlfa({ id: 4 }),
      acc({ id: 5 }) // живая
    ]
    const { d, removed } = deps(rows)
    const s = await runBankReaper(d, 30)
    expect(s.breach).toBe(true)
    expect(s.reaped).toBe(0)
    expect(removed).toEqual([])
  })

  it('строка изменилась под нами (gone/stale) — skipped, а не reaped/failed', async () => {
    const { d } = deps([deadAlfa({ id: 7 })], { remove: async () => 'stale' })
    const s = await runBankReaper(d, 30)
    expect(s.reaped).toBe(0)
    expect(s.skipped).toBe(1)
    expect(s.failed).toBe(0)
  })

  it('отказ базы на одной строке изолирован — прогон продолжается', async () => {
    let n = 0
    const { d } = deps([deadAlfa({ id: 1 }, 60), deadAlfa({ id: 2 }, 50)], {
      remove: async () => {
        n++
        if (n === 1) throw new Error('db boom')
        return 'removed'
      }
    })
    const s = await runBankReaper(d, 30)
    expect(s.failed).toBe(1)
    expect(s.reaped).toBe(1)
  })

  it('в логе НЕТ номера счёта и сырого member_id — только метка портала', async () => {
    const warn = vi.fn()
    const { d } = deps([deadAlfa({ id: 7, accountKey: 'BY99SECRET0001', memberId: 'member-raw-123' })], { warn })
    await runBankReaper(d, 30)
    const all = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(all).not.toContain('BY99SECRET0001')
    expect(all).not.toContain('member-raw-123')
  })
})
