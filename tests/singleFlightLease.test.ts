import { describe, expect, it, vi } from 'vitest'
import {
  acquireLease,
  deleteLeasesForPortal,
  isSingleFlightUnavailable,
  LEASE_RENEW_MS,
  portalLeaseKeys,
  eraseLeaseKey,
  provisionLeaseKey,
  recomputeLeaseKey,
  SINGLE_FLIGHT_LEASE_SEC,
  isSingleFlightBusy,
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
 * ⚠ Все оговорки читаются ИЗ ТЕКСТА ЗАПРОСА, а не зашиты в модель. Первая версия сравнивала токен
 * всегда — и мутация «снять аренду только по ключу» прошла ЗЕЛЁНОЙ: тест проверял мою модель, а не
 * production-SQL. Теперь пропажа `token = $2` или `WHERE … expires_at <= now()` меняет поведение
 * фейка ровно так же, как изменила бы поведение базы (замерено мутацией в обе стороны).
 *
 * ⚠ Сама атомарность `ON CONFLICT` фейком не проверяется и проверена быть не может — она замерена
 * на живом Postgres 16 (см. докстринг `acquireLease`); здесь моделируется только логика условий.
 */
/**
 * Срок — тоже ИЗ ТЕКСТА запроса, а не просто из параметра.
 *
 * ⚠ Найдено мутацией: пока модель брала `params[2]`, подмена `now() + make_interval(secs => $3)`
 * на голый `now()` проходила ЗЕЛЁНОЙ — а в проде это полное отключение взаимного исключения
 * (аренда мертва в момент захвата), то есть дубликаты смарт-процессов без отката.
 */
function ttlFromSql(sql: string, ttl: number): number {
  return /make_interval\(secs\s*=>\s*\$3\)/.test(sql) ? ttl : 0
}

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
      rows.set(key, { token, expiresAt: now + ttlFromSql(sql, ttl) * 1000 })
      return [{ token }]
    }
    if (sql.startsWith('UPDATE')) {
      const [key, token, ttl] = p as [string, string, number]
      const cur = rows.get(key)
      const byToken = /token\s*=\s*\$2/.test(sql)
      if (!cur || (byToken && cur.token !== token)) return []
      cur.expiresAt = now + ttlFromSql(sql, ttl) * 1000
      return [{ token }]
    }
    if (sql.includes('DELETE FROM')) {
      // Удаление порталом — множеством ключей (`key = ANY($1)`), снятие своей аренды — одним
      // ключом с токеном. Форма читается ИЗ ТЕКСТА, как и остальные оговорки.
      if (/key\s*=\s*ANY\(\$1\)/.test(sql)) {
        for (const k of p[0] as string[]) rows.delete(k)
        return []
      }
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

  it('во время работы аренда УДЕРЖИВАЕТСЯ — второй получает «занято»', async () => {
    // ⚠ Это и есть определение single-flight, и до мутационного прогона его не проверял никто:
    // все тесты смотрели, что аренда снята ПОСЛЕ работы. Мутация «снять сразу после захвата, до
    // fn» проходила зелёной — то есть набор допускал код, в котором взаимного исключения нет вовсе.
    const db = fakeDb()
    const d = deps(db)
    await withSingleFlightLease(d, 'k', 60, async () => {
      await expect(withSingleFlightLease(d, 'k', 60, async () => 'внутрь'))
        .rejects.toSatisfy(isSingleFlightBusy)
    })
  })

  it('аренда ПРОДЛЕВАЕТСЯ, пока работа идёт — операция не может пережить свой срок', async () => {
    // ⚠ Без продления срок обязан покрывать длительность операции, а она не ограничена ничем:
    // у обычного SDK-вызова таймаута нет, и один зависший запрос к порталу переживает любой запас.
    // Пережившая срок операция теряет исключительность МОЛЧА — второй админ входит внутрь, и в CRM
    // клиента появляются дубликаты смарт-процессов, откатить которые в проде нечем.
    vi.useFakeTimers()
    try {
      const db = fakeDb()
      const d = deps(db)
      let inside: () => void = () => {}
      const done = withSingleFlightLease(d, 'k', 3, () => new Promise<string>((r) => {
        inside = () => r('готово')
      }))
      // Проходит больше полного срока: без продления аренда была бы уже свободна.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000)
        db.advance(1000)
      }
      expect(await acquireLease(d.query, 'k', 3, 'чужой'), 'аренда протухла под живым держателем').toBeNull()
      inside()
      await done
    } finally {
      vi.useRealTimers()
    }
  })

  it('потеря аренды посреди работы не молчит', async () => {
    // ⚠ Прервать середину REST-цепочки нечем, поэтому единственное, что мы можем, — оставить след.
    // Без него разбор «откуда взялись два смарт-процесса» упирается в пустоту.
    vi.useFakeTimers()
    try {
      const db = fakeDb()
      const onLeaseLost = vi.fn()
      const d = { ...deps(db), onLeaseLost }
      let inside: () => void = () => {}
      const done = withSingleFlightLease(d, 'k', 3, () => new Promise<string>((r) => {
        inside = () => r('готово')
      }))
      await vi.advanceTimersByTimeAsync(10)
      db.rows.delete('k') // строку унесло: истекла и досталась другому / портал удалён
      await vi.advanceTimersByTimeAsync(1100)
      expect(onLeaseLost).toHaveBeenCalledWith('k')
      inside()
      await done
    } finally {
      vi.useRealTimers()
    }
  })

  it('нулевой и отрицательный срок НЕ отключают взаимное исключение', async () => {
    // ⚠ `now() + 0` делает условие `expires_at <= now()` истинным немедленно: внутрь заходит кто
    // угодно, при том что захват вернул токен и вызывающий уверен, что держит аренду. Сегодня
    // сроки захардкожены, но функция общая — первое же значение из env повторило бы это молча.
    const db = fakeDb()
    const d = deps(db)
    expect(await acquireLease(d.query, 'k', 0, d.newToken())).toBe('t1')
    expect(await acquireLease(d.query, 'k', 0, d.newToken()), 'нулевой срок отключил аренду').toBeNull()
    expect(await acquireLease(d.query, 'z', -5, d.newToken())).toBe('t3')
    expect(await acquireLease(d.query, 'z', -5, 'ещё'), 'отрицательный срок отключил аренду').toBeNull()
  })

  it('срок КОРОТКИЙ: он покрывает не длительность операции, а простой после смерти процесса', () => {
    // ⚠ Раньше сроков было два и они пытались покрыть измеренную длительность (5 и 15 минут).
    // С продлением это не нужно, и цена падения падает во столько же раз: портал заперт минуту,
    // а не четверть часа. Продление обязано быть заметно чаще срока — иначе одна неудачная
    // секунда базы роняет аренду под живым держателем.
    expect(SINGLE_FLIGHT_LEASE_SEC).toBeLessThanOrEqual(120)
    expect(LEASE_RENEW_MS * 2).toBeLessThanOrEqual(SINGLE_FLIGHT_LEASE_SEC * 1000)
  })

  it('ключи аренды — ПЕР-ПОРТАЛЬНЫЕ и различны у двух операций', () => {
    // ⚠ Мутация «ключ без memberId» проходила зелёной, а в проде это ровно тот общий семафор,
    // который в решении назван неверным: провижининг одного клиента отвечал бы «занято» всем
    // остальным порталам.
    expect(provisionLeaseKey('m1')).toContain('m1')
    expect(recomputeLeaseKey('m1')).toContain('m1')
    expect(provisionLeaseKey('m1')).not.toBe(provisionLeaseKey('m2'))
    expect(provisionLeaseKey('m1')).not.toBe(recomputeLeaseKey('m1'))
    // ⚠ Список ЗАКРЫТ: новая операция обязана попасть сюда, иначе её аренда переживёт удаление
    // приложения — портала уже нет, а строка в таблице держит его ключ.
    expect(portalLeaseKeys('m1')).toEqual([provisionLeaseKey('m1'), recomputeLeaseKey('m1'), eraseLeaseKey('m1')])
    expect(new Set(portalLeaseKeys('m1')).size).toBe(3) // ключи операций не совпадают между собой
  })

  it('удаление портала уносит ВСЕ его аренды и только его', async () => {
    // ⚠ У таблицы нет свипа, а обоснование «просроченную перезапишет следующий захват» держится
    // на том, что захват когда-нибудь будет. У удалённого портала его не будет никогда.
    const db = fakeDb()
    const d = deps(db, ['a', 'b', 'c'])
    for (const k of [...portalLeaseKeys('m1'), 'provision-sp:m2']) await acquireLease(d.query, k, 60, d.newToken())
    await deleteLeasesForPortal(d.query, 'm1')
    expect([...db.rows.keys()]).toEqual(['provision-sp:m2'])
  })

  it('отказ базы на захвате — это НАША сторона, отдельным типом', async () => {
    // ⚠ Различить по тексту нельзя: `connect ECONNREFUSED …:5432` совпадает с веткой «econn» и
    // читался бы как молчание портала, отправляя админа искать причину в Bitrix24.
    const query = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
    }) as unknown as QueryFn
    const e = await withSingleFlightLease({ query, newToken: () => 't' }, 'k', 60, async () => 'нет')
      .catch((err: unknown) => err)
    expect(isSingleFlightUnavailable(e)).toBe(true)
    expect(isSingleFlightBusy(e), 'отказ базы выдан за «занято»').toBe(false)
  })

  it('живая проводка выдаёт РАЗНЫЕ токены на каждое подключение', async () => {
    // ⚠ Мутация «newToken = () => 'lease'» в `liveDeps` проходила зелёной, а возвращает она ровно
    // тот дефект, ради которого токен стоит в `WHERE` снятия: все держатели неразличимы, и
    // запоздавшее снятие сносит чужую живую аренду. Сам модуль проводки не покрыт ничем.
    const { liveLeaseDeps } = await import('../server/utils/liveDeps')
    const a = liveLeaseDeps().newToken()
    const b = liveLeaseDeps().newToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
  })
})
