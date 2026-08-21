import { describe, expect, it } from 'vitest'
import { makeLockedRename } from '../server/utils/bankAccountRename'
import { BANK_REFRESH_LOCK_WAIT, DEFAULT_LOCK_WAIT } from '../server/utils/dbLock'
import { bankRefreshLockKey, PG_LOCK_TIMEOUT } from '../server/utils/bankRefreshLock'
import type { QueryFn } from '../server/utils/tokenStore'

// Проводка переименования под лок обновления токена (#509).
//
// Раньше это жило внутри `defineEventHandler` поверх живых `dbQuery`/`withAdvisoryLock`, где оба
// решения ниже были непроверяемы — а неправильными они выглядят точно так же, как правильными.

const q: QueryFn = async () => []

function deps(over: Partial<Parameters<typeof makeLockedRename>[0]> = {}) {
  const keys: string[] = []
  const waits: (string | undefined)[] = []
  const base = {
    withLock: async <T>(key: string, fn: (q: QueryFn) => Promise<T>, opts?: { lockWait?: string }): Promise<T> => {
      keys.push(key)
      waits.push(opts?.lockWait)
      return fn(q)
    },
    rename: async () => 'renamed' as const
  }
  return { keys, waits, made: makeLockedRename({ ...base, ...over }) }
}

describe('makeLockedRename', () => {
  it('берёт лок по СТАРОМУ ключу, а не по новому', async () => {
    // Самая тихая из возможных ошибок: лок по `toKey` берётся добросовестно, тест на «лок взят»
    // проходит, а с обновляющей стороной он не пересекается НИ РАЗУ — она держит строку под тем
    // ключом, который видит сейчас, то есть под старым.
    const { keys, made } = deps()
    await made('m1', 'alfa-by', '~pending:n1', 'BY01')
    expect(keys).toEqual([bankRefreshLockKey('m1', 'alfa-by', '~pending:n1')])
    expect(keys[0]).not.toContain('BY01')
  })

  it('переименование выполняется ВНУТРИ лока, а не рядом с ним', async () => {
    // Иначе лок — украшение: взяли, отпустили, и только потом тронули строку.
    const order: string[] = []
    const { made } = deps({
      withLock: async (_key, fn) => {
        order.push('lock-in')
        const r = await fn(q)
        order.push('lock-out')
        return r
      },
      rename: async () => {
        order.push('rename')
        return 'renamed'
      }
    })
    await made('m1', 'alfa-by', '~pending:n1', 'BY01')
    expect(order).toEqual(['lock-in', 'rename', 'lock-out'])
  })

  it('ждёт лок КОРОТКО, а не машинным умолчанием', async () => {
    // ⚠ Ожидающий держит соединение из пула (пул — 10) всё время ожидания. С машинным умолчанием
    // в 10 с один админ мог занять пул целиком, а из него же берут readiness-проба, события
    // установки и все остальные порталы. Плюс ждать десять секунд бессмысленно по-человечески:
    // держатель — POST к банку с потолком 15 с, дождаться его нельзя всё равно, а повтор в клике.
    const { waits, made } = deps()
    await made('m1', 'alfa-by', '~pending:n1', 'BY01')
    expect(waits).toEqual([BANK_REFRESH_LOCK_WAIT])
    expect(BANK_REFRESH_LOCK_WAIT).not.toBe(DEFAULT_LOCK_WAIT)
  })

  it('передаёт исходы хранилища как есть', async () => {
    for (const outcome of ['renamed', 'not-found', 'conflict'] as const) {
      const { made } = deps({ rename: async () => outcome })
      expect(await made('m1', 'alfa-by', '~pending:n1', 'BY01')).toBe(outcome)
    }
  })

  it('исчерпание ожидания лока — это «занято», а не ошибка', async () => {
    // Ждать можно 10 с, держатель — POST к банку с потолком 15 с: исход штатный.
    const { made } = deps({
      withLock: async () => {
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: PG_LOCK_TIMEOUT })
      }
    })
    expect(await made('m1', 'alfa-by', '~pending:n1', 'BY01')).toBe('busy')
  })

  it('настоящая ошибка БД пробрасывается, а не выдаётся за «занято»', async () => {
    // Проглотить её значило бы предложить человеку жать кнопку, пока не надоест, тогда как
    // причина в другом месте и сама не пройдёт.
    for (const code of ['57014', '23505', undefined]) {
      const { made } = deps({
        withLock: async () => {
          throw Object.assign(new Error('boom'), code ? { code } : {})
        }
      })
      await expect(made('m1', 'alfa-by', '~pending:n1', 'BY01')).rejects.toThrow('boom')
    }
  })
})
