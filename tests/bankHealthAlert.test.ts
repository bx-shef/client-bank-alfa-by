import { describe, expect, it } from 'vitest'
import { evaluateBankHealth } from '../server/utils/bankHealthAlert'
import type { BankHealthRow } from '../app/utils/bankHealthOverview'
import { BANK_REFRESH_TTL_SEC } from '../app/utils/bankTokenLifetime'
import { provisionalAccountKey } from '../app/utils/bankAccountKey'

// Умирающие подключения — в канал, который стучится САМ (#497 §3). Карточку на `/queues` надо
// открыть, а refresh Альфы умирает под утро (#488), когда на экран никто не смотрит.

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

function row(over: Partial<BankHealthRow> = {}): BankHealthRow {
  return {
    memberId: 'M1',
    provider: 'alfa-by',
    accountKey: 'BY01',
    connectedAt: NOW,
    expiresAt: NOW + HOUR,
    hasRefresh: true,
    ...over
  }
}

const deadAlfa = (over: Partial<BankHealthRow> = {}) => row({ hasRefresh: false, ...over })

describe('evaluateBankHealth', () => {
  it('здоровые подключения не будят никого', () => {
    expect(evaluateBankHealth([row(), row({ accountKey: 'B' })], NOW)).toEqual([])
  })

  it('пустой стор — тишина, а не тревога', () => {
    expect(evaluateBankHealth([], NOW)).toEqual([])
  })

  it('мёртвое подключение поднимает тревогу с числом подключений и порталов', () => {
    const [a] = evaluateBankHealth([
      deadAlfa({ memberId: 'M1', accountKey: 'A' }),
      deadAlfa({ memberId: 'M2', accountKey: 'B' })
    ], NOW)
    expect(a?.kind).toBe('bank-dead')
    expect(a?.queue).toBe('alfa-by')
    expect(a?.text).toContain('Альфа-Банк')
    expect(a?.text).toContain('2 подключения не работают')
    expect(a?.text).toContain('2 порталах')
  })

  it('«скоро обновим» — НЕ повод будить: это делаем мы сами', () => {
    // Разбудить оператора ради состояния, которое приложение чинит без него, — прямой путь к
    // тому, что канал перестанут читать.
    const age = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000 * 0.9
    expect(evaluateBankHealth([row({ connectedAt: NOW - age })], NOW)).toEqual([])
  })

  it('истёкшее подключение — повод', () => {
    const age = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000 + HOUR
    const alerts = evaluateBankHealth([row({ connectedAt: NOW - age })], NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.text).toContain('1 подключение не работает')
  })

  it('незавершённая настройка — НЕ поломка: опрашивать по ней нечего, будить некого', () => {
    const rows = [row({ accountKey: provisionalAccountKey('n1'), hasRefresh: false })]
    expect(evaluateBankHealth(rows, NOW)).toEqual([])
  })

  it('угаданный срок Приора не хоронит подключение — как и везде в цепочке', () => {
    const age = BANK_REFRESH_TTL_SEC['prior-by'] * 1000 + HOUR
    expect(evaluateBankHealth([row({ provider: 'prior-by', connectedAt: NOW - age })], NOW)).toEqual([])
  })

  it('ЭПИЗОД НА ПРОВАЙДЕРА — хронически мёртвая Альфа не маскирует свежую поломку Приора', () => {
    // Один общий эпизод молчал бы про Приор: «уже объявлено» сработало бы раньше.
    const alerts = evaluateBankHealth([
      deadAlfa({ provider: 'alfa-by', accountKey: 'A' }),
      deadAlfa({ provider: 'prior-by', accountKey: 'B' })
    ], NOW)
    expect(alerts.map(a => a.queue)).toEqual(['alfa-by', 'prior-by'])
  })

  it('порядок тревог не зависит от порядка строк в БД', () => {
    const rows = [
      deadAlfa({ provider: 'prior-by', accountKey: 'B' }),
      deadAlfa({ provider: 'alfa-by', accountKey: 'A' })
    ]
    const a = evaluateBankHealth(rows, NOW).map(x => x.queue)
    const b = evaluateBankHealth([...rows].reverse(), NOW).map(x => x.queue)
    expect(a).toEqual(b)
  })
})

describe('приватность сообщения', () => {
  it('в тексте нет ни номеров счетов, ни member_id, ни меток порталов', () => {
    // Telegram — ВНЕШНИЙ сервис, и отправленное туда уже не отозвать. Числа отвечают на вопрос
    // «идти ли смотреть»; смотреть идут на экран за нашей сессией.
    const alerts = evaluateBankHealth([
      deadAlfa({ memberId: 'SECRET-MEMBER', accountKey: 'BY00SECRET0001' })
    ], NOW)
    const text = alerts.map(a => a.text).join('\n')
    expect(text).not.toContain('SECRET-MEMBER')
    expect(text).not.toContain('BY00SECRET0001')
  })
})
