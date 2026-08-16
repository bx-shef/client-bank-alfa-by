import { describe, expect, it } from 'vitest'
import { sweepAbandonedPending, resolvePendingMaxAgeDays } from '../server/utils/pendingSweep'
import { bankRefreshLockKey, PG_LOCK_TIMEOUT } from '../server/utils/bankRefreshLock'
import { abandonedPending, PENDING_MAX_AGE_DAYS } from '../app/utils/bankTokenLifetime'
import { ALFA_REFRESH_TOKEN_TTL_SEC } from '../app/utils/alfaOauth'
import { provisionalAccountKey } from '../app/utils/bankAccountKey'
import type { BankAccountInfo } from '../server/utils/bankTokenStore'

// Свип брошенных ожидающих подключений (#485).
//
// Главное, что здесь проверяется, — что свип НЕ трогает живое. Строка с выбранным счётом это
// работающий импорт клиента, и ошибка в одну сторону стоит несравнимо дороже, чем в другую:
// не подмели мусор — некрасиво; снесли живое — клиент идёт в интернет-банк переподключаться.

const DAY = 86_400_000
const NOW = 1_800_000_000_000

function row(over: Partial<BankAccountInfo> = {}): BankAccountInfo {
  return {
    memberId: 'm1',
    provider: 'alfa-by',
    accountKey: provisionalAccountKey('n1'),
    connectedAt: NOW - DAY * 3,
    expiresAt: NOW + 3600_000,
    hasRefresh: true,
    consentExpiresAt: 0,
    ...over
  }
}

const q = {} as never

function deps(rows: BankAccountInfo[], over: Partial<Parameters<typeof sweepAbandonedPending>[0]> = {}) {
  const removed: string[] = []
  const locks: string[] = []
  return {
    removed,
    locks,
    made: {
      now: () => NOW,
      list: async () => rows,
      withLock: async <T>(key: string, fn: (q: never) => Promise<T>): Promise<T> => {
        locks.push(key)
        return fn(q)
      },
      // По умолчанию строка под локом та же, что была в снимке.
      reread: async (_q: never, m: string, p: string, a: string) =>
        rows.find(r => r.memberId === m && r.provider === p && r.accountKey === a) ?? null,
      remove: async (_q: never, m: string, p: string, a: string) => {
        removed.push(`${m}|${p}|${a}`)
        return true
      },
      ...over
    }
  }
}

describe('abandonedPending', () => {
  it('НИКОГДА не трогает подключение с выбранным счётом', () => {
    // Самая дорогая из возможных ошибок этого модуля. Живая строка бывает и старой, и в зоне
    // обновления — это работа keep-alive, а не свипа.
    for (const key of ['BY01ALFA0001', 'BY04PJCB30120000000000000000']) {
      expect(abandonedPending(row({ accountKey: key, connectedAt: NOW - DAY * 365 }), NOW)).toBe(false)
      expect(abandonedPending(row({ accountKey: key, hasRefresh: false }), NOW)).toBe(false)
      expect(abandonedPending(row({ accountKey: key, consentExpiresAt: NOW - DAY }), NOW)).toBe(false)
    }
  })

  it('сносит ожидающее с истёкшим СОГЛАСИЕМ немедленно, не дожидаясь возраста', () => {
    // Согласие — ответ банка, а не наша оценка: выбор счёта на такой строке дал бы подключение,
    // которое отвалится на первом же обращении.
    const fresh = row({ connectedAt: NOW - 60_000, consentExpiresAt: NOW - 1 })
    expect(abandonedPending(fresh, NOW)).toBe(true)
  })

  it('сносит ожидающее, у которого вышел ИЗМЕРЕННЫЙ срок refresh', () => {
    // Альфа — измеренный срок (#488), поэтому «истекло» здесь факт, а не догадка.
    const dead = row({ connectedAt: NOW - (ALFA_REFRESH_TOKEN_TTL_SEC * 1000 + 1) })
    expect(abandonedPending(dead, NOW)).toBe(true)
  })

  it('на УГАДАННОМ сроке ждёт потолка возраста, а не хоронит по догадке', () => {
    // У Приора срок не измерен: объявить смерть по нему значило бы сносить живые подключения.
    const young = row({ provider: 'prior-by', connectedAt: NOW - DAY })
    expect(abandonedPending(young, NOW)).toBe(false)
    const old = row({ provider: 'prior-by', connectedAt: NOW - DAY * (PENDING_MAX_AGE_DAYS + 1) })
    expect(abandonedPending(old, NOW)).toBe(true)
  })

  it('порог — РОВНО значение константы, и граница включительная', () => {
    // ⚠ Тесты выше сравнивают возраст с ИМПОРТОМ константы, то есть самоссылочно: подмена самой
    // `PENDING_MAX_AGE_DAYS` (2 → 11) проходила мимо них зелёной (найдено ревью тестировщика).
    // А это бизнес-параметр: «банк вечером, номер утром» держится именно на нём.
    expect(PENDING_MAX_AGE_DAYS).toBe(2)
    const prior = (ms: number) => row({ provider: 'prior-by', connectedAt: NOW - ms })
    const cap = PENDING_MAX_AGE_DAYS * DAY
    expect(abandonedPending(prior(cap + 1), NOW)).toBe(true)
    expect(abandonedPending(prior(cap), NOW)).toBe(true)
    expect(abandonedPending(prior(cap - 1), NOW)).toBe(false)
  })

  it('пол суток встроен в САМУ функцию, а не только в разбор env', () => {
    // Иначе гарантия «не снесёт слишком свежее» держится на дисциплине единственного вызывающего.
    expect(abandonedPending(row({ connectedAt: NOW }), NOW, 0)).toBe(false)
    expect(abandonedPending(row({ connectedAt: NOW }), NOW, -5)).toBe(false)
    expect(abandonedPending(row({ connectedAt: NOW - DAY - 1 }), NOW, 0)).toBe(true)
  })

  it('свежее ожидающее остаётся — человек ещё вернётся', () => {
    // Банк вечером, номер утром — обычный сценарий. Снести раньше значит послать проходить банк заново.
    expect(abandonedPending(row({ connectedAt: NOW - 3600_000 }), NOW)).toBe(false)
  })
})

describe('sweepAbandonedPending', () => {
  it('удаляет только брошенные и только их', async () => {
    const rows = [
      row({ accountKey: '~pending:old', connectedAt: NOW - DAY * 5 }),
      row({ accountKey: '~pending:fresh', connectedAt: NOW - 3600_000 }),
      row({ accountKey: 'BY01ALFA0001', connectedAt: NOW - DAY * 500 })
    ]
    const { removed, made } = deps(rows)
    expect(await sweepAbandonedPending(made)).toBe(1)
    expect(removed).toEqual(['m1|alfa-by|~pending:old'])
  })

  it('сбой на одной строке не отменяет остальные', async () => {
    // Свип идёт по ВСЕМ порталам сразу: один битый ряд не должен оставлять мусор у всех прочих.
    const rows = [
      row({ memberId: 'm1', accountKey: '~pending:a', connectedAt: NOW - DAY * 5 }),
      row({ memberId: 'm2', accountKey: '~pending:b', connectedAt: NOW - DAY * 5 })
    ]
    const { made } = deps(rows, {
      remove: async (_q: never, m: string) => {
        if (m === 'm1') throw new Error('connection lost')
        return true
      }
    })
    expect(await sweepAbandonedPending(made)).toBe(1)
  })

  it('считает только фактически удалённые', async () => {
    // Строку мог унести параллельный `disconnect` — засчитать её значило бы врать в логе ретенции.
    const { made } = deps([row({ connectedAt: NOW - DAY * 5 })], { remove: async () => false })
    expect(await sweepAbandonedPending(made)).toBe(0)
  })

  it('НЕ сносит строку, которую keep-alive омолодил, пока мы ждали лок', async () => {
    // ⚠ Ради этого и введён перечит. Отбор идёт по снимку начала тика; keep-alive НАМЕРЕННО
    // продлевает и ожидающие подключения (#489), и без перечита свип сносил бы строку, которую тот
    // только что доказал живой у банка — то есть обесценивал механику, написанную ради этих строк.
    const stale = row({ connectedAt: NOW - DAY * 5 })
    const { removed, made } = deps([stale], {
      reread: async () => row({ connectedAt: NOW - 60_000 })
    })
    expect(await sweepAbandonedPending(made)).toBe(0)
    expect(removed).toEqual([])
  })

  it('берёт ТОТ ЖЕ лок, что обновление токена и выбор счёта', async () => {
    // Иначе сериализации нет: три писателя в одну строку, и двое из них друг друга не видят.
    const { locks, made } = deps([row({ connectedAt: NOW - DAY * 5 })])
    expect(await sweepAbandonedPending(made)).toBe(1)
    expect(locks).toEqual([bankRefreshLockKey('m1', 'alfa-by', '~pending:n1')])
  })

  it('строка исчезла под локом — считаем ноль, а не ошибку', async () => {
    const { made } = deps([row({ connectedAt: NOW - DAY * 5 })], { reread: async () => null })
    expect(await sweepAbandonedPending(made)).toBe(0)
  })

  it('не дождались лока — тихо пропускаем, это не сбой', async () => {
    // Держатель — работающий рефреш (POST к банку до 15 с). Строка брошена, подметём на следующем
    // тике; писать про это в лог значило бы шуметь при штатной работе.
    const { made } = deps([row({ connectedAt: NOW - DAY * 5 })], {
      withLock: async () => {
        throw Object.assign(new Error('lock timeout'), { code: PG_LOCK_TIMEOUT })
      }
    })
    expect(await sweepAbandonedPending(made)).toBe(0)
  })

  it('пустая база — ноль и без обращений к удалению', async () => {
    const { removed, made } = deps([])
    expect(await sweepAbandonedPending(made)).toBe(0)
    expect(removed).toEqual([])
  })
})

describe('resolvePendingMaxAgeDays', () => {
  it('мусор и пусто ⇒ дефолт', () => {
    for (const raw of [undefined, '', '  ', 'abc', 'NaN']) {
      expect(resolvePendingMaxAgeDays(raw)).toBe(PENDING_MAX_AGE_DAYS)
    }
  })

  it('клампит: пол — сутки, потолок — 30 дней', () => {
    // ⚠ Пол принципиален: значение меньше суток превратило бы свип в уборщика ЖИВЫХ настроек —
    // подключение, начатое вечером, исчезало бы до утра.
    expect(resolvePendingMaxAgeDays('0')).toBe(1)
    expect(resolvePendingMaxAgeDays('-5')).toBe(1)
    expect(resolvePendingMaxAgeDays('999')).toBe(30)
    expect(resolvePendingMaxAgeDays('7')).toBe(7)
  })
})
