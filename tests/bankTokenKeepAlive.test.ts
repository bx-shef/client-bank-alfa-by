import { describe, expect, it, vi } from 'vitest'
import type { BankAccountInfo, BankToken } from '../server/utils/bankTokenStore'
import {
  BANK_KEEP_ALIVE_MINUTES, BANK_REFRESH_TTL_SEC, MAX_BANK_KEEP_ALIVE_BATCH,
  bankKeepAliveIntervalMs, narrowestBandMs, refreshAtAgeMs, runBankKeepAlive,
  selectBankAccountsNearExpiry, type BankKeepAliveDeps
} from '../server/utils/bankTokenKeepAlive'

// Мотив, а не только предмет: подключение Альфы, давшее первые 208 боевых операций, умерло за
// ~16 часов — refresh банка живёт ~10 ч, а обновлял его только сам опрос по дороге (#488).
// Здесь закреплено то, что делает keep-alive: он смотрит на возраст ПАРЫ, а не на срок
// access-токена, и он честно отделяет «нечего обновлять» от «обновить не вышло».

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

function acc(over: Partial<BankAccountInfo> = {}): BankAccountInfo {
  return {
    memberId: 'M1',
    provider: 'alfa-by',
    accountKey: 'BY00BANK00000000000000000001',
    connectedAt: NOW - HOUR,
    expiresAt: NOW + HOUR,
    hasRefresh: true,
    ...over
  }
}

describe('selectBankAccountsNearExpiry', () => {
  it('свежее подключение не трогаем — лишний рефреш это запрос к банку', () => {
    const r = selectBankAccountsNearExpiry([acc({ connectedAt: NOW - HOUR })], NOW)
    expect(r.due).toEqual([])
    expect(r.unrefreshable).toEqual([])
  })

  it('Альфа за 9 часов до истечения — в очереди на обновление', () => {
    // TTL 10 ч, полоса 20% ⇒ обновляем начиная с возраста 8 ч.
    const r = selectBankAccountsNearExpiry([acc({ connectedAt: NOW - 9 * HOUR })], NOW)
    expect(r.due).toEqual([{ memberId: 'M1', provider: 'alfa-by', accountKey: 'BY00BANK00000000000000000001' }])
  })

  it('граница считается от СРОКА ЖИЗНИ ПРОВАЙДЕРА, а не одна на всех', () => {
    // Один и тот же возраст: для Альфы (10 ч) это уже пора, для Приора (12 ч) ещё нет.
    const age = NOW - 9 * HOUR
    const rows = [acc({ connectedAt: age }), acc({ provider: 'prior-by', accountKey: 'P1', connectedAt: age })]
    const r = selectBankAccountsNearExpiry(rows, NOW)
    expect(r.due.map(d => d.provider)).toEqual(['alfa-by'])
  })

  it('подключение БЕЗ refresh-токена — не «не пора», а «невозможно»', () => {
    // Приор может не выдать refresh вовсе. Ретраить такое вечно значит жечь лимит банка на
    // запросе, который не может пройти; лечится только повторной авторизацией человеком.
    const r = selectBankAccountsNearExpiry([acc({ hasRefresh: false, connectedAt: NOW - 20 * HOUR })], NOW)
    expect(r.due).toEqual([])
    expect(r.unrefreshable).toHaveLength(1)
  })

  it('провайдер с неизвестным сроком жизни ПРОПУСКАЕТСЯ, а не обновляется постоянно', () => {
    // `manual` (и любой банк, чей срок мы ещё не знаем) даёт порог 0 — а «возраст ≥ 0» верно
    // для всего на свете. Без явного пропуска это был бы бесконечный цикл запросов.
    const r = selectBankAccountsNearExpiry([acc({ provider: 'manual', connectedAt: NOW - 99 * HOUR })], NOW)
    expect(r.due).toEqual([])
  })

  it('ожидающее подключение (#407) обновляем тоже — иначе админ вернётся к мёртвому', () => {
    // Опрос такие счета намеренно пропускает, но токен у них настоящий, и смысл в том, чтобы
    // человек мог закончить настройку завтра.
    const r = selectBankAccountsNearExpiry([acc({ accountKey: '~pending:abc', connectedAt: NOW - 9 * HOUR })], NOW)
    expect(r.due).toHaveLength(1)
  })

  it('самые старые первыми и не больше капа', () => {
    const rows = Array.from({ length: MAX_BANK_KEEP_ALIVE_BATCH + 5 }, (_, i) =>
      acc({ accountKey: `A${i}`, connectedAt: NOW - (20 + i) * HOUR }))
    const r = selectBankAccountsNearExpiry(rows.slice().reverse(), NOW)
    expect(r.due).toHaveLength(MAX_BANK_KEEP_ALIVE_BATCH)
    // Порядок по возрасту: первым идёт самый старый из набора.
    expect(r.due[0]!.accountKey).toBe(`A${rows.length - 1}`)
  })

  it('непарсибельная метка времени пропускается, а не обновляется вслепую', () => {
    const r = selectBankAccountsNearExpiry([acc({ connectedAt: Number.NaN })], NOW)
    expect(r.due).toEqual([])
  })
})

describe('runBankKeepAlive', () => {
  function deps(over: Partial<BankKeepAliveDeps> = {}): { d: BankKeepAliveDeps, warn: string[], log: string[] } {
    const warn: string[] = []
    const log: string[] = []
    const d: BankKeepAliveDeps = {
      now: () => NOW,
      listAccounts: async () => [acc({ connectedAt: NOW - 9 * HOUR })],
      getToken: async ref => ({
        memberId: ref.memberId, provider: ref.provider, accountKey: ref.accountKey,
        accessToken: 'a', refreshToken: 'r', expiresAt: NOW + HOUR
      }),
      refresh: async (t: BankToken) => ({ ...t, expiresAt: t.expiresAt + HOUR }),
      warn: m => warn.push(m),
      log: m => log.push(m),
      ...over
    }
    return { d, warn, log }
  }

  it('обновляет то, что пора, и отчитывается счётчиками', async () => {
    const { d } = deps()
    await expect(runBankKeepAlive(d)).resolves.toEqual({
      selected: 1, refreshed: 1, skipped: 0, failed: 0, unrefreshable: 0
    })
  })

  it('счёт исчез между перечислением и загрузкой → skipped, не ошибка', async () => {
    const { d } = deps({ getToken: async () => null })
    await expect(runBankKeepAlive(d)).resolves.toMatchObject({ selected: 1, refreshed: 0, skipped: 1, failed: 0 })
  })

  it('срок не вырос → считаем пропуском: пару обновил параллельный опрос под тем же локом', async () => {
    const { d } = deps({ refresh: async t => t })
    await expect(runBankKeepAlive(d)).resolves.toMatchObject({ refreshed: 0, skipped: 1 })
  })

  it('отказ банка по ОДНОМУ счёту не останавливает остальные', async () => {
    // Иначе один клиент с отозванным согласием выключал бы keep-alive всем.
    const rows = [acc({ accountKey: 'BAD', connectedAt: NOW - 9 * HOUR }), acc({ accountKey: 'OK', connectedAt: NOW - 9 * HOUR })]
    const { d, warn } = deps({
      listAccounts: async () => rows,
      refresh: async (t) => {
        if (t.accountKey === 'BAD') throw new Error('invalid_grant')
        return { ...t, expiresAt: t.expiresAt + HOUR }
      }
    })
    await expect(runBankKeepAlive(d)).resolves.toMatchObject({ selected: 2, refreshed: 1, failed: 1 })
    expect(warn.some(w => w.includes('invalid_grant'))).toBe(true)
  })

  it('подключения без refresh называются в логе поимённо — их чинит только человек', async () => {
    const { d, warn } = deps({ listAccounts: async () => [acc({ hasRefresh: false, accountKey: 'NOREFRESH' })] })
    const s = await runBankKeepAlive(d)
    expect(s).toMatchObject({ selected: 0, unrefreshable: 1 })
    expect(warn.some(w => w.includes('NOREFRESH') && w.includes('reconnect'))).toBe(true)
  })

  it('номер счёта в логе санитизируется — он может быть IBAN', async () => {
    const { d, warn } = deps({
      listAccounts: async () => [acc({ accountKey: 'BY00\nINJECTED', connectedAt: NOW - 9 * HOUR })],
      refresh: async () => { throw new Error('nope') }
    })
    await runBankKeepAlive(d)
    expect(warn.join('\n')).not.toContain('\nINJECTED')
  })

  it('отказ ПЕРЕЧИСЛЕНИЯ пробрасывается — это не пер-аккаунтная беда, а сломанная БД', async () => {
    const { d } = deps({
      listAccounts: async () => {
        throw new Error('db down')
      }
    })
    await expect(runBankKeepAlive(d)).rejects.toThrow('db down')
  })

  it('насыщение батча слышно — иначе часть подключений тихо не успела бы', async () => {
    const rows = Array.from({ length: MAX_BANK_KEEP_ALIVE_BATCH }, (_, i) =>
      acc({ accountKey: `A${i}`, connectedAt: NOW - 9 * HOUR }))
    const { d, warn } = deps({ listAccounts: async () => rows })
    await runBankKeepAlive(d)
    expect(warn.some(w => w.includes('saturated'))).toBe(true)
  })
})

describe('каденция и инварианты', () => {
  it('интервал клампится — опечатка не превращает это в цикл запросов к банку', () => {
    expect(bankKeepAliveIntervalMs(60)).toBe(60 * 60_000)
    expect(bankKeepAliveIntervalMs(0)).toBe(BANK_KEEP_ALIVE_MINUTES * 60_000)
    expect(bankKeepAliveIntervalMs(1)).toBe(5 * 60_000)
    expect(bankKeepAliveIntervalMs(99_999)).toBe(240 * 60_000)
    expect(bankKeepAliveIntervalMs(Number.NaN)).toBe(BANK_KEEP_ALIVE_MINUTES * 60_000)
  })

  it('⚠ сканирование ЧАЩЕ самой узкой полосы — иначе можно перешагнуть окно целиком', () => {
    // Это и есть инвариант, ради которого написан `narrowestBandMs`: если каденция станет
    // шире полосы (кто-то поднимет период «чтобы не дёргать банк»), токен успеет умереть
    // между двумя сканами, и keep-alive будет существовать, ничего не делая.
    expect(bankKeepAliveIntervalMs(BANK_KEEP_ALIVE_MINUTES)).toBeLessThan(narrowestBandMs())
  })

  it('срок жизни задан для КАЖДОГО провайдера — новый банк не скомпилируется молча', () => {
    // `Record<BankProviderId, number>` — компиляторный сторож; тест сторожит значения.
    expect(BANK_REFRESH_TTL_SEC['alfa-by']).toBe(36_000) // 10 ч, подтверждено вживую (#488)
    expect(BANK_REFRESH_TTL_SEC['prior-by']).toBeGreaterThan(0)
    expect(BANK_REFRESH_TTL_SEC.manual).toBe(0) // онлайн-токена нет
    expect(refreshAtAgeMs('alfa-by')).toBe(8 * HOUR)
  })
})

describe('проводка в кроне', () => {
  it('keep-alive НЕ гейтится флагом опроса выписки', async () => {
    // Ровно эта сцепка и убивала подключение: `CRON_REAL_POLL` заведён, чтобы не дёргать
    // ВЫПИСКУ, а обновление токена выпиской не является. Сторожим текстом плагина.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../server/plugins/queue.ts', import.meta.url), 'utf8')
    // Границы берём по маркерам самого блока, а не «N символов назад»: соседний блок опроса
    // упоминает флаг законно, и окно по длине поймало бы его, а не нашу проводку.
    const from = src.indexOf('// Keep-alive БАНКОВСКИХ токенов')
    const to = src.indexOf('bankKeepAliveTimer = setInterval')
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    const block = src.slice(from, to)
    expect(block).not.toContain('CRON_REAL_POLL=')
    expect(block).not.toContain('envFlag(\'CRON_REAL_POLL')
    expect(block).toContain('force: true') // без force смотрели бы на срок access-токена
  })
})

vi.mock('node:crypto', async orig => orig())
