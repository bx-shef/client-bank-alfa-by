import { describe, expect, it } from 'vitest'
import { makeLockedAddAccount } from '../server/utils/bankAccountAdd'
import { BANK_REFRESH_LOCK_WAIT } from '../server/utils/dbLock'
import { bankRefreshLockKey, PG_LOCK_TIMEOUT } from '../server/utils/bankRefreshLock'
import type { QueryFn } from '../server/utils/tokenStore'

// Добавление счёта под грантовым локом (#23, находка ревью по гонкам).
//
// ⚠ Смысл лока не очевиден и потому закреплён здесь: мы ВСТАВЛЯЕМ новую строку, а не спорим за
// живую. Но `INSERT … SELECT` при read committed не блокируется на НЕЗАКОММИЧЕННОМ `UPDATE`
// обновления — он читает предыдущую версию строки, и в окно между «обновление записало ротированную
// пару» и «обновление закоммитилось» новая строка унесла бы refresh, который банк уже отозвал.

const q: QueryFn = async () => []

function deps(over: Partial<Parameters<typeof makeLockedAddAccount>[0]> = {}) {
  const keys: string[] = []
  const waits: (string | undefined)[] = []
  const base = {
    withLock: async <T>(key: string, fn: (q: QueryFn) => Promise<T>, opts?: { lockWait?: string }): Promise<T> => {
      keys.push(key)
      waits.push(opts?.lockWait)
      return fn(q)
    },
    add: async () => 'added' as const,
    grantOf: async () => ({ provider: 'alfa-by' as const, grantId: 'G1' })
  }
  return { keys, waits, made: makeLockedAddAccount({ ...base, ...over }) }
}

describe('makeLockedAddAccount', () => {
  it('берёт ГРАНТОВЫЙ лок — тот же, что держит обновление токена', async () => {
    const { keys, made } = deps()
    expect(await made('m1', 5, 'BY01', 'BY02')).toBe('added')
    expect(keys).toEqual([bankRefreshLockKey('m1', 'alfa-by', 'BY01', 'G1')])
    expect(keys[0]).toContain('G1')
  })

  it('вставка идёт ВНУТРИ лока, а не рядом с ним', async () => {
    // Иначе лок — украшение: взяли, отпустили, и только потом тронули таблицу.
    const order: string[] = []
    const { made } = deps({
      withLock: async (_key, fn) => {
        order.push('lock-in')
        const r = await fn(q)
        order.push('lock-out')
        return r
      },
      add: async () => {
        order.push('add')
        return 'added'
      }
    })
    await made('m1', 5, 'BY01', 'BY02')
    expect(order).toEqual(['lock-in', 'add', 'lock-out'])
  })

  it('ждёт лок КОРОТКО, а не машинным умолчанием', async () => {
    // ⚠ На этом конце человек, ткнувший кнопку, а держит лок сетевой POST к банку с потолком 15 с:
    // дождаться его нельзя, а повтор — в одном клике.
    const { waits, made } = deps()
    await made('m1', 5, 'BY01', 'BY02')
    expect(waits).toEqual([BANK_REFRESH_LOCK_WAIT])
  })

  it('не дождались лока — «занято», а не ошибка БД', async () => {
    const { made } = deps({
      withLock: async () => {
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: PG_LOCK_TIMEOUT })
      }
    })
    expect(await made('m1', 5, 'BY01', 'BY02')).toBe('busy')
  })

  it('НАСТОЯЩАЯ ошибка БД пробрасывается, а не выдаётся за «занято»', async () => {
    const { made } = deps({
      withLock: async () => {
        throw Object.assign(new Error('connection refused'), { code: '08006' })
      }
    })
    await expect(made('m1', 5, 'BY01', 'BY02')).rejects.toThrow('connection refused')
  })

  it('строки нет — `gone` БЕЗ занятия лока', async () => {
    const { keys, made } = deps({ grantOf: async () => null })
    expect(await made('m1', 5, 'BY01', 'BY02')).toBe('gone')
    expect(keys).toEqual([])
  })

  it('грант не размечен — `unmarked` БЕЗ занятия лока', async () => {
    // Лок по счёту здесь не пересёкся бы с обновлением этой строки в любом случае, а исход известен.
    const { keys, made } = deps({ grantOf: async () => ({ provider: 'alfa-by', grantId: '' }) })
    expect(await made('m1', 5, 'BY01', 'BY02')).toBe('unmarked')
    expect(keys).toEqual([])
  })

  it('ключ лока берёт банк ИЗ СТРОКИ, а не из ввода', async () => {
    // Банк вызывающий не присылает вовсе — иначе им можно было бы выбрать чужой лок.
    const { keys, made } = deps({ grantOf: async () => ({ provider: 'prior-by', grantId: 'G9' }) })
    await made('m1', 5, 'BY01', 'BY02')
    expect(keys[0]).toContain('prior-by')
  })
})
