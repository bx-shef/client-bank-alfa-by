import { describe, expect, it, vi } from 'vitest'
import {
  accountConfirmLogLine, MAX_CONFIRM_PORTALS_PER_RUN, runAccountConfirm, type AccountConfirmDeps
} from '../server/utils/accountConfirmRun'
import type { BankAccountInfo } from '../server/utils/bankTokenStore'

// Подтверждение счёта банком (#615) — граница, за которой начинается раздача чужой выписки.

const NOW = 1_800_000_000_000

function row(over: Partial<BankAccountInfo> = {}): BankAccountInfo {
  return {
    id: 1, memberId: 'M1', provider: 'alfa-by', accountKey: 'BY09ALFA1',
    connectedAt: NOW, expiresAt: NOW, hasRefresh: true, lastAttemptAt: 0,
    consentExpiresAt: 0, accountConfirmedAt: 0, grantId: '', pollPaused: false, ...over
  }
}

/** Два портала заявили ОДИН номер и оба не подтверждены — единственный случай, когда мы спрашиваем. */
const disputed = () => [row({ id: 1, memberId: 'A' }), row({ id: 2, memberId: 'B' })]

function deps(over: Partial<AccountConfirmDeps> = {}): AccountConfirmDeps {
  return {
    now: () => NOW,
    listRows: async () => disputed(),
    bankSide: async () => [{ provider: 'alfa-by', accounts: [{ number: 'BY09ALFA1' }] }],
    confirm: async () => 1,
    ...over
  }
}

describe('подтверждение счёта банком', () => {
  it('спорный счёт: банк назвал номер — строка отмечается', async () => {
    const confirm = vi.fn(async () => 1)
    const s = await runAccountConfirm(deps({ confirm }))
    expect(s.candidates).toBe(2)
    expect(s.confirmed).toBe(2)
    expect(confirm).toHaveBeenCalledWith('A', 'alfa-by', ['BY09ALFA1'], NOW)
  })

  it('банк НЕ назвал номер — не подтверждаем', async () => {
    // Ровно тот случай, ради которого всё написано: админ вписал ЧУЖОЙ IBAN.
    const confirm = vi.fn(async () => 0)
    const s = await runAccountConfirm(deps({
      bankSide: async () => [{ provider: 'alfa-by', accounts: [{ number: 'BY99OTHER' }] }],
      confirm
    }))
    // Отметку получает то, что назвал банк; чужой номер в списке не окажется и останется без неё.
    expect(confirm).toHaveBeenCalledWith('A', 'alfa-by', ['BY99OTHER'], NOW)
    expect(s.confirmed).toBe(0)
  })

  it('спора нет — НИ ОДНОГО обращения к банку', async () => {
    // ⚠ На обычном флоте (у каждого свой счёт) проход обязан быть бесплатным.
    const bankSide = vi.fn(async () => [])
    const s = await runAccountConfirm(deps({
      listRows: async () => [row({ memberId: 'A', accountKey: 'BY01' }), row({ memberId: 'B', accountKey: 'BY02' })],
      bankSide
    }))
    expect(bankSide).not.toHaveBeenCalled()
    expect(s).toMatchObject({ candidates: 0, asked: 0, confirmed: 0 })
  })

  it('банк ответил ошибкой по провайдеру — НИЧЕГО не подтверждаем', async () => {
    const confirm = vi.fn(async () => 1)
    await runAccountConfirm(deps({
      bankSide: async () => [{ provider: 'alfa-by', accounts: [], error: 'банк не ответил (503)' }],
      confirm
    }))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('ошибка ВМЕСТЕ с частичным списком — тоже не подтверждаем', async () => {
    // ⚠ Отдельный тест, потому что предыдущий проходил и со снятой проверкой ошибки: у ответа с
    // ошибкой список был пуст, и его отсекал следующий гейт (замерено мутацией). Ответ с ошибкой
    // и НЕПУСТЫМ списком — реальный случай (часть страниц отдалась, часть нет), и список в нём
    // заведомо неполный: подтверждать по нему значит верить оборванному ответу.
    const confirm = vi.fn(async () => 1)
    await runAccountConfirm(deps({
      bankSide: async () => [{
        provider: 'alfa-by',
        accounts: [{ number: 'BY09ALFA1' }],
        error: 'банк не ответил (503)'
      }],
      confirm
    }))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('второй банк портала подтверждается, даже если первый упал', async () => {
    const confirm = vi.fn(async () => 1)
    await runAccountConfirm(deps({
      bankSide: async () => [
        { provider: 'alfa-by', accounts: [], error: 'банк не ответил' },
        { provider: 'prior-by', accounts: [{ number: 'BY77PRIOR' }] }
      ],
      confirm
    }))
    expect(confirm).toHaveBeenCalledWith('A', 'prior-by', ['BY77PRIOR'], NOW)
  })

  it('отказ на одном портале не отменяет остальные', async () => {
    const bankSide = vi.fn(async (m: string) => {
      if (m === 'A') throw new Error('сеть моргнула')
      return [{ provider: 'alfa-by' as const, accounts: [{ number: 'BY09ALFA1' }] }]
    })
    const s = await runAccountConfirm(deps({ bankSide }))
    expect(s.failed).toBe(1)
    expect(s.confirmed).toBe(1)
  })

  it('сырой member_id в лог не попадает', async () => {
    const lines: string[] = []
    await runAccountConfirm(deps({
      listRows: async () => [row({ memberId: 'portal-secret' }), row({ id: 2, memberId: 'B' })],
      bankSide: async () => { throw new Error('банк молчит') },
      log: m => lines.push(m),
      warn: m => lines.push(m)
    }))
    expect(lines.join(' ')).not.toContain('portal-secret')
  })

  it('за прогон спрашиваем не больше потолка', async () => {
    const many = Array.from({ length: MAX_CONFIRM_PORTALS_PER_RUN + 3 }, (_, i) =>
      row({ id: i + 1, memberId: `M${i}` }))
    const bankSide = vi.fn(async () => [{ provider: 'alfa-by' as const, accounts: [{ number: 'BY09ALFA1' }] }])
    const s = await runAccountConfirm(deps({ listRows: async () => many, bankSide }))
    expect(s.asked).toBe(MAX_CONFIRM_PORTALS_PER_RUN)
    expect(s.capped).toBe(true)
    expect(bankSide).toHaveBeenCalledTimes(MAX_CONFIRM_PORTALS_PER_RUN)
  })

  it('нечего делать — молчим, а не печатаем нулевую строку', () => {
    // ⚠ Обратное решение, чем у автоотключения (#614): тот рвёт связь с банком и обязан отчитаться
    // всегда, а этот на здоровом флоте не делает ничего — и ежедневная строка «кандидатов 0» была
    // бы чистым шумом в логе, который читают ради настоящих проблем.
    expect(accountConfirmLogLine({ candidates: 0, asked: 0, confirmed: 0, failed: 0, capped: false })).toBeNull()
    expect(accountConfirmLogLine({ candidates: 2, asked: 2, confirmed: 2, failed: 0, capped: false }))
      .toContain('подтверждено строк 2')
  })
})
