import { describe, expect, it, vi } from 'vitest'
import {
  acquireLease,
  isSingleFlightBusy,
  PROVISION_LEASE_SEC,
  RECOMPUTE_LEASE_SEC,
  releaseLease,
  SingleFlightBusyError,
  withSingleFlightLease
} from '../server/utils/singleFlightLease'
import type { QueryFn } from '../server/utils/tokenStore'

/**
 * Модель таблицы аренд с ЧАСАМИ БАЗЫ. Она не «упрощает SQL», а воспроизводит два его свойства,
 * на которых всё и держится: захват проверяет срок (`DO UPDATE … WHERE expires_at <= now()`), а
 * снятие адресуется парой ключ+токен. Часы держит модель, а не вызывающий — иначе тест молча
 * разрешил бы то, что запрещено в проде: судить о чужой аренде по своим часам.
 *
 * ⚠ Обе оговорки читаются ИЗ ТЕКСТА ЗАПРОСА, а не зашиты в модель. Первая версия сравнивала токен
 * всегда — и мутация «снять аренду только по ключу» прошла ЗЕЛЁНОЙ: тест проверял мою модель, а не
 * production-SQL. Теперь пропажа `token = $2` или `WHERE … expires_at <= now()` меняет поведение
 * фейка ровно так же, как изменила бы поведение базы (замерено мутацией в обе стороны).
 *
 * ⚠ Сама атомарность `ON CONFLICT` фейком не проверяется и проверена быть не может — она замерена
 * на живом Postgres 16 (см. докстринг `acquireLease`); здесь моделируется только логика условий.
 */
function fakeDb() {
  const rows = new Map<string, { token: string, expiresAt: number }>()
  let now = 1_000_000
  const query: QueryFn = async (sql, params) => {
    const p = (params ?? []) as unknown[]
    if (sql.includes('INSERT INTO')) {
      const [key, token, ttl] = p as [string, string, number]
      const guarded = /WHERE[\s\S]*expires_at\s*<=\s*now\(\)/.test(sql)
      const cur = rows.get(key)
      if (guarded && cur && cur.expiresAt > now) return []
      rows.set(key, { token, expiresAt: now + ttl * 1000 })
      return [{ token }]
    }
    if (sql.includes('DELETE FROM')) {
      const [key, token] = p as [string, string]
      const byToken = /token\s*=\s*\$2/.test(sql)
      if (!byToken || rows.get(key)?.token === token) rows.delete(key)
      return []
    }
    throw new Error(`неожиданный SQL: ${sql}`)
  }
  return {
    query,
    rows,
    advance: (ms: number) => {
      now += ms
    }
  }
}

const deps = (db: ReturnType<typeof fakeDb>, tokens: string[] = ['t1', 't2', 't3']) => {
  let i = 0
  return { query: db.query, newToken: () => tokens[i++] ?? `t${i}` }
}

describe('аренда single-flight (#538)', () => {
  it('второй вызывающий получает «занято», а не встаёт в очередь', async () => {
    // ⚠ Именно НЕ ждёт: держателя (десятки секунд у провижининга, минуты у пересчёта) дождаться
    // нельзя, а работы у второго нет — первый делает ровно то же самое.
    const db = fakeDb()
    const d = deps(db)
    expect(await acquireLease(d.query, 'k', 60, d.newToken())).toBe('t1')
    expect(await acquireLease(d.query, 'k', 60, d.newToken())).toBeNull()
  })

  it('аренда снимается после работы — следующий вызывающий входит сразу', async () => {
    const db = fakeDb()
    const d = deps(db)
    await withSingleFlightLease(d, 'k', 60, async () => 'готово')
    expect(db.rows.size, 'аренда осталась висеть после успеха').toBe(0)
    await expect(withSingleFlightLease(d, 'k', 60, async () => 'ещё раз')).resolves.toBe('ещё раз')
  })

  it('падение внутри работы снимает аренду, а не запирает портал до конца срока', async () => {
    const db = fakeDb()
    const d = deps(db)
    await expect(withSingleFlightLease(d, 'k', 60, async () => {
      throw new Error('портал отказал')
    })).rejects.toThrow('портал отказал')
    expect(db.rows.size).toBe(0)
  })

  it('просроченная аренда достаётся следующему — смерть процесса не запирает портал навсегда', async () => {
    // ⚠ Это цена размена на advisory-лок: тот освобождался сам при обрыве соединения, аренду
    // освобождает только срок. Поэтому срок обязан истекать — иначе один упавший провижининг
    // закрывал бы порталу настройку до перезапуска.
    const db = fakeDb()
    const d = deps(db)
    expect(await acquireLease(d.query, 'k', 60, d.newToken())).toBe('t1')
    db.advance(61_000)
    expect(await acquireLease(d.query, 'k', 60, d.newToken())).toBe('t2')
  })

  it('запоздавшее снятие не трогает ЧУЖУЮ аренду', async () => {
    // ⚠ Ради этого в снятии и стоит токен. Без него операция, пережившая свой срок, удаляла бы
    // аренду, взятую к тому моменту уже кем-то другим, — и внутрь заходили бы двое. Для
    // провижининга это дубли смарт-процессов в CRM клиента, откатить которые в проде нечем.
    const db = fakeDb()
    const d = deps(db)
    const mine = await acquireLease(d.query, 'k', 60, d.newToken())
    db.advance(61_000)
    const theirs = await acquireLease(d.query, 'k', 60, d.newToken())
    await releaseLease(d.query, 'k', mine!)
    expect(db.rows.get('k')?.token, 'снесли чужую живую аренду').toBe(theirs)
  })

  it('отказ снятия не превращает успешную операцию в ошибку', async () => {
    // ⚠ Провижининг уже создал смарт-процессы. Ответив 502 из-за неудавшегося DELETE, мы отправили
    // бы админа создавать их второй раз — ровно то, чего вся конструкция и не допускает.
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('DELETE')) throw new Error('база отвалилась')
      return [{ token: 't1' }] as Record<string, unknown>[]
    }) as unknown as QueryFn
    await expect(withSingleFlightLease({ query, newToken: () => 't1' }, 'k', 60, async () => 'ок'))
      .resolves.toBe('ок')
  })

  it('«занято» опознаётся предикатом и не путается с настоящей ошибкой', async () => {
    expect(isSingleFlightBusy(new SingleFlightBusyError('k'))).toBe(true)
    expect(isSingleFlightBusy(new Error('connection terminated'))).toBe(false)
    expect(isSingleFlightBusy(Object.assign(new Error('lock'), { code: '55P03' }))).toBe(false)
    const db = fakeDb()
    const d = deps(db)
    await acquireLease(d.query, 'k', 60, d.newToken())
    await expect(withSingleFlightLease(d, 'k', 60, async () => 'нет'))
      .rejects.toSatisfy(isSingleFlightBusy)
  })

  it('сроки покрывают собственный потолок операции, а пересчёт — с запасом к провижинингу', () => {
    // ⚠ Не круглые числа ради красоты: срок, который короче самой операции, отдаёт аренду второму
    // вызывающему ПОСРЕДИ работы первого — то есть ровно та двойная запись, ради запрета которой
    // всё написано. Пересчёт обходит каждый платёж портала по два REST-вызова, провижининг — ~18
    // вызовов; при потолке SDK в 2 запроса в секунду это минуты против секунд.
    expect(PROVISION_LEASE_SEC).toBeGreaterThanOrEqual(120)
    expect(RECOMPUTE_LEASE_SEC).toBeGreaterThan(PROVISION_LEASE_SEC)
  })
})
