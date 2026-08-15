import { describe, expect, it } from 'vitest'
import { HEALTH_ORDER, HEALTH_TITLE, summarizeBankHealth, type BankHealthRow } from '../app/utils/bankHealthOverview'
import { BANK_REFRESH_TTL_SEC, refreshAtAgeMs } from '../app/utils/bankTokenLifetime'
import { provisionalAccountKey } from '../app/utils/bankAccountKey'

// Обзор состояния подключений ДЛЯ НАС (#497 §3). Умирающее подключение сегодня узнаётся по факту
// неработающего импорта — то есть позже клиента, тогда как критерий приёмки сформулирован ровно
// наоборот: «бухгалтер видит свои платежи, а МЫ видим его проблемы».

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

describe('summarizeBankHealth', () => {
  it('пустой стор — честные нули, а не отсутствие ответа', () => {
    const s = summarizeBankHealth([], NOW)
    expect(s.total).toEqual({ connections: 0, portals: 0 })
    expect(s.needAttention).toBe(0)
    expect(s.byHealth.ok.connections).toBe(0)
  })

  it('считает и подключения, и ПОРТАЛЫ — это разные числа', () => {
    // Пять умерших подключений одного клиента и пять у пяти разных — совершенно разные ситуации,
    // и по одному счётчику их не отличить.
    const s = summarizeBankHealth([
      row({ memberId: 'M1', accountKey: 'A' }),
      row({ memberId: 'M1', accountKey: 'B' }),
      row({ memberId: 'M2', accountKey: 'C' })
    ], NOW)
    expect(s.total).toEqual({ connections: 3, portals: 2 })
    expect(s.byHealth.ok).toEqual({ connections: 3, portals: 2 })
  })

  it('без refresh-токена — «нужно переподключить», и портал попадает в требующие внимания', () => {
    const s = summarizeBankHealth([row({ hasRefresh: false })], NOW)
    expect(s.byHealth['no-refresh'].connections).toBe(1)
    expect(s.needAttention).toBe(1)
  })

  it('в полосе обновления — «скоро обновим», человека не требует', () => {
    const age = refreshAtAgeMs('alfa-by') + HOUR
    const s = summarizeBankHealth([row({ connectedAt: NOW - age })], NOW)
    expect(s.byHealth.due.connections).toBe(1)
    expect(s.needAttention).toBe(0)
  })

  it('старше измеренного срока — «истекло» и требует человека', () => {
    const age = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000 + HOUR
    const s = summarizeBankHealth([row({ connectedAt: NOW - age })], NOW)
    expect(s.byHealth.expired.connections).toBe(1)
    expect(s.needAttention).toBe(1)
  })

  it('портал считается требующим внимания ОДИН раз, даже если у него сломано несколько счетов', () => {
    // Чинится это походом к конкретному клиенту, а не «в среднем по больнице»: важно число
    // разговоров, которые предстоят, а не число строк.
    const s = summarizeBankHealth([
      row({ memberId: 'M1', accountKey: 'A', hasRefresh: false }),
      row({ memberId: 'M1', accountKey: 'B', hasRefresh: false }),
      row({ memberId: 'M1', accountKey: 'C', connectedAt: NOW - BANK_REFRESH_TTL_SEC['alfa-by'] * 1000 - HOUR })
    ], NOW)
    expect(s.needAttention).toBe(1)
    expect(s.byHealth['no-refresh'].connections).toBe(2)
  })

  it('ожидающие подключения считаются ОТДЕЛЬНО и не выдаются за здоровые', () => {
    // Формально они живы, но опрашивать по ним нечего — у банка нет такого «номера». Смешав их с
    // `ok`, экран показывал бы здоровье там, где настройка просто не закончена.
    const s = summarizeBankHealth([
      row({ accountKey: provisionalAccountKey('n1') }),
      row({ accountKey: 'BY01' })
    ], NOW)
    expect(s.pending).toEqual({ connections: 1, portals: 1 })
    expect(s.byHealth.ok.connections).toBe(1)
    expect(s.total.connections).toBe(2)
  })

  it('угаданный срок жизни не превращается в «истекло» — как и на сервере, и в интерфейсе', () => {
    // Инвариант держится по всей цепочке: у Приора цифра — догадка, и хоронить по ней нельзя нигде.
    const age = BANK_REFRESH_TTL_SEC['prior-by'] * 1000 + HOUR
    const s = summarizeBankHealth([row({ provider: 'prior-by', connectedAt: NOW - age })], NOW)
    expect(s.byHealth.expired.connections).toBe(0)
    expect(s.byHealth.due.connections).toBe(1)
    expect(s.needAttention).toBe(0)
  })
})

describe('подача на экране', () => {
  it('сначала то, что требует человека — экран не должен начинаться с «всё хорошо»', () => {
    expect(HEALTH_ORDER[0]).toBe('no-refresh')
    expect(HEALTH_ORDER[1]).toBe('expired')
    expect(HEALTH_ORDER[HEALTH_ORDER.length - 1]).toBe('ok')
  })

  it('у каждого состояния есть подпись', () => {
    for (const h of HEALTH_ORDER) expect(HEALTH_TITLE[h]?.length).toBeGreaterThan(0)
  })

  it('порядок покрывает ВСЕ состояния — новое не должно молча исчезнуть с экрана', () => {
    expect([...HEALTH_ORDER].sort()).toEqual(Object.keys(HEALTH_TITLE).sort())
  })
})

describe('приватность сводки', () => {
  it('в ответе нет ни номеров счетов, ни идентификаторов порталов', () => {
    // Оператор смотрит сюда, чтобы понять «что-то ломается и у скольких», а не чтобы читать
    // реквизиты чужих компаний.
    const s = summarizeBankHealth([row({ memberId: 'SECRET-MEMBER', accountKey: 'BY00SECRET0001' })], NOW)
    const json = JSON.stringify(s)
    expect(json).not.toContain('SECRET-MEMBER')
    expect(json).not.toContain('BY00SECRET0001')
  })
})
