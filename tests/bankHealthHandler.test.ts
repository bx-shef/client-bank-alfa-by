import { describe, expect, it } from 'vitest'
import { handleBankHealth, READ_FAILED } from '../server/utils/bankHealthHandler'
import type { BankHealthRow } from '../app/utils/bankHealthOverview'

// Вся ценность роута в ОДНОЙ ветке: недоступная база обязана дать 503, а не пустую сводку. Пока
// эта ветка была зашита в `defineEventHandler` поверх живого `dbQuery`, провалить её было некому.

const NOW = 1_700_000_000_000

function row(over: Partial<BankHealthRow> = {}): BankHealthRow {
  return {
    memberId: 'M1',
    provider: 'alfa-by',
    accountKey: 'BY01',
    connectedAt: NOW,
    expiresAt: NOW + 3_600_000,
    hasRefresh: true,
    ...over
  }
}

const io = (over: Partial<Parameters<typeof handleBankHealth>[0]> = {}) => ({
  listRows: async () => [row()],
  now: () => NOW,
  hashPortal: (m: string) => `h(${m})`,
  ...over
})

describe('handleBankHealth', () => {
  it('отдаёт сводку на 200', async () => {
    const { status, body } = await handleBankHealth(io())
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, total: { connections: 1, portals: 1 } })
  })

  it('НЕДОСТУПНАЯ БАЗА — 503, а не пустая сводка', async () => {
    // Ноль подключений читался бы как «всё спокойно» ровно тогда, когда спокойно точно не всё.
    const { status, body } = await handleBankHealth(io({
      listRows: async () => { throw new Error('ECONNREFUSED 10.0.0.5:5432') }
    }))
    expect(status).toBe(503)
    expect(body).toEqual({ ok: false, error: READ_FAILED })
  })

  it('текст ошибки БД наружу НЕ уходит — только в лог', async () => {
    // Сообщение pg несёт хост/порт базы, имена таблиц при рассинхроне схемы, иногда имя
    // пользователя БД. Ветка срабатывает именно при аварии — то есть в худший момент.
    const seen: string[] = []
    const { body } = await handleBankHealth(io({
      listRows: async () => { throw new Error('relation "bank_tokens" does not exist @ db-prod:5432') },
      warn: (m: string) => seen.push(m)
    }))
    const json = JSON.stringify(body)
    expect(json).not.toContain('db-prod')
    expect(json).not.toContain('bank_tokens')
    expect(seen.join('\n')).toContain('db-prod')
  })

  it('пустой стор — честный 200 с нулями (это не отказ)', async () => {
    const { status, body } = await handleBankHealth(io({ listRows: async () => [] }))
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, total: { connections: 0, portals: 0 }, needAttention: 0 })
  })

  it('метки порталов — хешированные, сырой member_id в ответ не попадает', async () => {
    const { body } = await handleBankHealth(io({
      listRows: async () => [row({ memberId: 'SECRET-MEMBER', hasRefresh: false })]
    }))
    const json = JSON.stringify(body)
    expect(json).toContain('h(SECRET-MEMBER)')
    expect(json).not.toContain('"SECRET-MEMBER"')
  })
})
