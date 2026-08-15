import { describe, expect, it, vi } from 'vitest'
import type { BankAccountInfo, BankToken } from '../server/utils/bankTokenStore'
import {
  BANK_KEEP_ALIVE_MINUTES, BANK_REFRESH_TTL_SEC, MAX_BANK_KEEP_ALIVE_BATCH,
  MIN_BANK_KEEP_ALIVE_MINUTES, bankKeepAliveIntervalMs, maxBankKeepAliveMinutes,
  narrowestBandMs, refreshAtAgeMs, runBankKeepAlive,
  selectBankAccountsNearExpiry, type BankKeepAliveDeps
} from '../server/utils/bankTokenKeepAlive'
import { connectionHealth } from '../app/utils/bankTokenLifetime'

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
    // Возраст держим ВНУТРИ окна [8 ч, 10 ч) — за ним строка считается истёкшей и в очередь не
    // попадает вовсе (см. тест ниже), поэтому шаг минутный, а не часовой.
    const rows = Array.from({ length: MAX_BANK_KEEP_ALIVE_BATCH + 5 }, (_, i) =>
      acc({ accountKey: `A${i}`, connectedAt: NOW - (8 * HOUR + i * 60_000) }))
    const r = selectBankAccountsNearExpiry(rows.slice().reverse(), NOW)
    expect(r.due).toHaveLength(MAX_BANK_KEEP_ALIVE_BATCH)
    // Порядок по возрасту: первым идёт самый старый из набора.
    expect(r.due[0]!.accountKey).toBe(`A${rows.length - 1}`)
  })

  it('граница ВКЛЮЧИТЕЛЬНАЯ: возраст ровно на пороге — уже пора', () => {
    // Классическое место для случайной замены `>=` на `>` при рефакторинге.
    const r = selectBankAccountsNearExpiry([acc({ connectedAt: NOW - refreshAtAgeMs('alfa-by') })], NOW)
    expect(r.due).toHaveLength(1)
  })

  it('⚠ старше ВСЕГО срока жизни — «expired», и мы его НЕ дёргаем', () => {
    // Отозванный банком грант не обновляет `updated_at` — рефреш падает раньше сохранения.
    // Без верхней границы такая строка сортируется первой, занимает капнутый батч и приносит
    // банку новый запрос НА КАЖДОМ тике, вечно. Это и есть путь к «вы нас злоупотребляете»,
    // достижимый без единой ошибки в настройке — просто накоплением отозванных подключений.
    const r = selectBankAccountsNearExpiry([acc({ connectedAt: NOW - 11 * HOUR })], NOW)
    expect(r.due).toEqual([])
    expect(r.expired).toHaveLength(1)
  })

  it('мёртвая строка не вытесняет живые из капнутого батча', () => {
    const rows = [
      acc({ accountKey: 'DEAD', connectedAt: NOW - 50 * HOUR }),
      acc({ accountKey: 'ALIVE', connectedAt: NOW - 9 * HOUR })
    ]
    const r = selectBankAccountsNearExpiry(rows, NOW, { limit: 1 })
    expect(r.due.map(d => d.accountKey)).toEqual(['ALIVE'])
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
      selected: 1, refreshed: 1, skipped: 0, failed: 0, unrefreshable: 0, expired: 0
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

  it('истёкшие подключения названы в логе и НЕ ретраятся', async () => {
    const { d, warn } = deps({ listAccounts: async () => [acc({ accountKey: 'DEAD', connectedAt: NOW - 50 * HOUR })] })
    const s = await runBankKeepAlive(d)
    expect(s).toMatchObject({ selected: 0, expired: 1, failed: 0 })
    expect(warn.some(w => w.includes('DEAD') && w.includes('NOT retried'))).toBe(true)
  })

  it('длинный список не разворачивается в одну гигантскую строку лога', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => acc({ accountKey: `N${i}`, hasRefresh: false }))
    const { d, warn } = deps({ listAccounts: async () => rows })
    await runBankKeepAlive(d)
    expect(warn.some(w => w.includes('+30 more'))).toBe(true)
  })

  it('насыщение батча слышно — иначе часть подключений тихо не успела бы', async () => {
    const rows = Array.from({ length: MAX_BANK_KEEP_ALIVE_BATCH + 1 }, (_, i) =>
      acc({ accountKey: `A${i}`, connectedAt: NOW - 9 * HOUR }))
    const { d, warn } = deps({ listAccounts: async () => rows })
    await runBankKeepAlive(d)
    expect(warn.some(w => w.includes('saturated'))).toBe(true)
  })

  it('РОВНО потолок подключений — тревоги нет: полный батч обработан целиком, никто не потерян', () => {
    // Прежде тревога выводилась из `due.length === cap` и на границе кричала впустую. Предупреждение,
    // срабатывающее когда всё в порядке, — это способ отучить от предупреждений вообще.
    const rows = Array.from({ length: MAX_BANK_KEEP_ALIVE_BATCH }, (_, i) =>
      acc({ accountKey: `A${i}`, connectedAt: NOW - 9 * HOUR }))
    expect(selectBankAccountsNearExpiry(rows, NOW).truncated).toBe(false)
  })

  it('на одного больше потолка — усечение честно объявлено', () => {
    const rows = Array.from({ length: MAX_BANK_KEEP_ALIVE_BATCH + 1 }, (_, i) =>
      acc({ accountKey: `A${i}`, connectedAt: NOW - 9 * HOUR }))
    const sel = selectBankAccountsNearExpiry(rows, NOW)
    expect(sel.truncated).toBe(true)
    expect(sel.due).toHaveLength(MAX_BANK_KEEP_ALIVE_BATCH)
  })
})

describe('каденция и инварианты', () => {
  it('интервал клампится — опечатка не превращает это в цикл запросов к банку', () => {
    expect(bankKeepAliveIntervalMs(60)).toBe(60 * 60_000)
    expect(bankKeepAliveIntervalMs(0)).toBe(BANK_KEEP_ALIVE_MINUTES * 60_000)
    expect(bankKeepAliveIntervalMs(1)).toBe(5 * 60_000)
    // Верхний потолок ВЫВОДИТСЯ из полосы, а не выбран числом: 60 мин = половина 2-часовой
    // полосы Альфы. Прежний фиксированный кламп (240 мин) был ШИРЕ полосы, то есть законная
    // настройка «пореже, чтобы не дёргать банк» возвращала ту самую ночную смерть — молча.
    expect(bankKeepAliveIntervalMs(99_999)).toBe(maxBankKeepAliveMinutes() * 60_000)
    expect(maxBankKeepAliveMinutes() * 60_000).toBeLessThan(narrowestBandMs())
    expect(bankKeepAliveIntervalMs(Number.NaN)).toBe(BANK_KEEP_ALIVE_MINUTES * 60_000)
  })

  it('⚠ сканирование ЧАЩЕ самой узкой полосы — при ЛЮБОМ допустимом значении', () => {
    // Это и есть инвариант, ради которого выводится потолок: если каденция станет шире полосы,
    // токен успеет умереть между двумя сканами, и keep-alive будет существовать, ничего не делая.
    // Проверяем не только дефолт, но и границы — прежняя версия проверяла лишь дефолт и потому
    // пропускала легальные значения, которые инвариант нарушают.
    for (const m of [1, MIN_BANK_KEEP_ALIVE_MINUTES, BANK_KEEP_ALIVE_MINUTES, 10_000]) {
      expect(bankKeepAliveIntervalMs(m)).toBeLessThan(narrowestBandMs())
    }
  })

  it('срок жизни задан для КАЖДОГО провайдера — новый банк не скомпилируется молча', () => {
    // `Record<BankProviderId, number>` — компиляторный сторож; тест сторожит значения.
    expect(BANK_REFRESH_TTL_SEC['alfa-by']).toBe(36_000) // 10 ч, подтверждено вживую (#488)
    expect(BANK_REFRESH_TTL_SEC['prior-by']).toBeGreaterThan(0)
    expect(BANK_REFRESH_TTL_SEC.manual).toBe(0) // онлайн-токена нет
    expect(refreshAtAgeMs('alfa-by')).toBe(8 * HOUR)
    // ⚠ Пин ЗНАЧЕНИЯ, а не неравенства: перепутанный множитель в формуле полосы дал бы 32 ч
    // вместо 2 ч, и проверка «каденция меньше полосы» осталась бы зелёной на сломанной формуле.
    expect(narrowestBandMs()).toBe(2 * HOUR)
    expect(BANK_KEEP_ALIVE_MINUTES).toBe(60) // документировано в .env.example и QUEUES.md
  })
})

describe('проводка в кроне', () => {
  it('keep-alive НЕ гейтится флагом опроса выписки', async () => {
    // Ровно эта сцепка и убивала подключение: `CRON_REAL_POLL` заведён, чтобы не дёргать
    // ВЫПИСКУ, а обновление токена выпиской не является.
    //
    // ⚠ Считаем упоминания флага ВО ВСЁМ ФАЙЛЕ, а не внутри вырезанного окна. Оконная проверка
    // (первая редакция этого теста) не ловила самый правдоподобный регресс: обернуть весь
    // банковский крон-блок СНАРУЖИ одним `if (CRON_REAL_POLL)` «чтобы сгруппировать». Обёртка
    // ложится ДО маркера, в окно не попадает, и тест остаётся зелёным на сломанном коде.
    // Приём взят у `priorAuthSingleChokePoint.test.ts` — «единственная законная точка».
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../server/plugins/queue.ts', import.meta.url), 'utf8')
    const mentions = [...src.matchAll(/process\.env\.CRON_REAL_POLL\b|envFlag\(['"]CRON_REAL_POLL/g)]
    expect(mentions).toHaveLength(1) // единственное законное — сам опрос выписки
  })

  it('обновление вызывается ПРИНУДИТЕЛЬНО', async () => {
    // Без `force` смотрели бы на срок access-токена — тот сигнал, которого как раз не хватает.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../server/plugins/queue.ts', import.meta.url), 'utf8')
    const from = src.indexOf('bankKeepAliveDeps')
    const to = src.indexOf('bankKeepAliveTimer = setInterval')
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    expect(src.slice(from, to)).toContain('force: true')
  })
})

vi.mock('node:crypto', async orig => orig())

describe('угаданный срок жизни не хоронит подключение (ревью #489)', () => {
  // Для Приора срок — консервативная ДОГАДКА (`BANK_REFRESH_TTL_MEASURED['prior-by'] === false`).
  // Интерфейс на догадке «истекло» не говорит принципиально; сервер обязан судить так же, иначе
  // расхождение выходит в худшую сторону: обновлять перестали, а бейдж спокойно пишет «скоро
  // обновим», и подключение умирает молча — ровно то, ради чего писался весь модуль.
  const NOW = 1_700_000_000_000
  const row = (provider: 'alfa-by' | 'prior-by', ageMs: number) => ({
    memberId: 'M', provider, accountKey: 'BY1',
    connectedAt: NOW - ageMs, expiresAt: NOW, hasRefresh: true
  })

  it('Приор старше своего УГАДАННОГО срока — остаётся в очереди на обновление, не в «истекло»', () => {
    const ttlMs = BANK_REFRESH_TTL_SEC['prior-by'] * 1000
    const sel = selectBankAccountsNearExpiry([row('prior-by', ttlMs + 60_000)], NOW)
    expect(sel.expired).toHaveLength(0)
    expect(sel.due).toHaveLength(1)
  })

  it('Альфа старше своего ИЗМЕРЕННОГО срока — по-прежнему «истекло», пол против долбёжки на месте', () => {
    const ttlMs = BANK_REFRESH_TTL_SEC['alfa-by'] * 1000
    const sel = selectBankAccountsNearExpiry([row('alfa-by', ttlMs + 60_000)], NOW)
    expect(sel.expired).toHaveLength(1)
    expect(sel.due).toHaveLength(0)
  })

  it('решение сервера и подпись в интерфейсе не расходятся ни для одного банка', () => {
    // Инвариант, а не пример: «сервер похоронил» обязано совпадать с «интерфейс говорит истекло».
    for (const provider of ['alfa-by', 'prior-by'] as const) {
      const ttlMs = BANK_REFRESH_TTL_SEC[provider] * 1000
      const conn = row(provider, ttlMs + 60_000)
      const serverBuried = selectBankAccountsNearExpiry([conn], NOW).expired.length > 0
      const uiSaysExpired = connectionHealth(conn, NOW) === 'expired'
      expect(serverBuried).toBe(uiSaysExpired)
    }
  })
})

describe('истёкшее согласие не тратит запросы банка (#503)', () => {
  // ⚠ Согласие — не наша догадка о сроке, а дата от самого банка. Когда она прошла, refresh не
  // может удаться в принципе: слать его — тратить лимит банка на заведомо провальный запрос.
  const T = 1_700_000_000_000
  const row = (over: Record<string, unknown> = {}) => ({
    memberId: 'm1', provider: 'prior-by' as const, accountKey: 'BY01',
    connectedAt: T - 60_000, expiresAt: T + 600_000, hasRefresh: true, consentExpiresAt: 0, ...over
  })

  it('согласие истекло — в «expired», а не в «due», даже у свежего токена', () => {
    const sel = selectBankAccountsNearExpiry([row({ consentExpiresAt: T - 1 })], T)
    expect(sel.due).toEqual([])
    expect(sel.expired).toHaveLength(1)
  })

  it('согласие истекло — перекрывает и «нет refresh-токена»', () => {
    // Оба требуют человека, но причина разная, и решает та, которую назвал банк.
    const sel = selectBankAccountsNearExpiry([row({ consentExpiresAt: T - 1, hasRefresh: false })], T)
    expect(sel.unrefreshable).toEqual([])
    expect(sel.expired).toHaveLength(1)
  })

  it('согласие живо — прежнее поведение не изменилось', () => {
    const old = row({ consentExpiresAt: T + 30 * 86_400_000, connectedAt: T - 11 * 3_600_000 })
    expect(selectBankAccountsNearExpiry([old], T).due).toHaveLength(1)
  })

  it('ДАТЫ НЕТ — ничего не меняется: у Альфы согласий нет вовсе', () => {
    const alfa = row({ provider: 'alfa-by' as const, consentExpiresAt: 0, connectedAt: T - 9 * 3_600_000 })
    const sel = selectBankAccountsNearExpiry([alfa], T)
    expect(sel.expired).toEqual([])
    expect(sel.due).toHaveLength(1)
  })
})
