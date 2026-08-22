import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PRIOR_STATEMENT_PAGES,
  PRIOR_PAGE_DELAY_MS,
  PRIOR_POLL_MAX_ATTEMPTS,
  fetchPriorStatement,
  isRetryablePollStatus,
  isoDateOnly,
  looksLikePageBoundary,
  priorApiBaseFromEnv,
  priorNextPageUrl,
  PRIOR_WALK_BUDGET_MS,
  priorPollDelayMs, PRIOR_POLL_DELAY_MS, PRIOR_POLL_MAX_DELAY_MS, PRIOR_POLL_BUDGET_MS,
  priorWalkNotice,
  resolvePriorAccountId,
  type PriorFetchDeps,
  unreadEnvelopeKeys,
  walkPriorPages
} from '../server/utils/priorFetch'
import { normalizePriorTransactionList } from '../app/utils/priorStatement'
import { PRIOR_RESOURCE_NOT_CREATED } from '../app/utils/priorOauth'
import type { BankToken } from '../server/utils/bankTokenStore'
import type { BankFetchQuery } from '../server/utils/bankFetch'

const tok: BankToken = {
  memberId: 'm1', provider: 'prior-by', accountKey: 'ACC-1',
  accessToken: 'ACCESS', refreshToken: 'R', expiresAt: 9_999_999_999_999
}
const query: BankFetchQuery = { memberId: 'm1', provider: 'prior-by', account: 'ACC-1', dateFrom: '2026-07-01', dateTo: '2026-07-10' }

/** A ready transaction-list response (what the poll returns once generated). */
function readyResponse() {
  return {
    data: {
      accountId: 'ACC-1',
      transaction: [
        { transactionId: 't1', creditDebitIndicator: 'Credit', amount: 100, currency: 'BYN', transactionDetails: 'оплата', bookingDateTime: '2026-07-02T10:00:00+03:00', debtor: { name: 'ООО Ромашка' } },
        { transactionId: 't2', creditDebitIndicator: 'Debit', amount: 40, currency: 'BYN', transactionDetails: 'комиссия', bookingDateTime: '2026-07-03T10:00:00+03:00', creditor: { name: 'Банк' } }
      ]
    }
  }
}
const pendingResponse = { errors: [{ code: PRIOR_RESOURCE_NOT_CREATED, message: 'still generating' }] }

/** `GET /accounts` — the bridge from our stored IBAN to Prior's opaque accountId. */
const ACCOUNTS_RESPONSE = {
  data: { account: [
    { accountId: 'OPAQUE-9', accountDetails: { identification: 'ACC-1' }, currency: 'BYN' },
    { accountId: 'OTHER-1', accountDetails: { identification: 'ZZZ-9' }, currency: 'USD' }
  ] }
}

function fakeDeps(over: Partial<PriorFetchDeps> & { pollSequence?: unknown[], pollStatus?: number } = {}) {
  const calls = { getUrl: [] as string[], postUrl: [] as string[], pollUrl: [] as string[], sleeps: [] as number[], ensured: 0 }
  const pollSequence = over.pollSequence ? [...over.pollSequence] : [readyResponse()]
  const deps: PriorFetchDeps = {
    ensureFresh: async (t) => {
      calls.ensured++
      return { ...t, accessToken: 'FRESH' }
    },
    apiBase: () => 'https://prior:9344', // gateway origin (the OB prefix is added by the path builder)
    getJson: async (url) => {
      calls.getUrl.push(url)
      return ACCOUNTS_RESPONSE
    },
    postJson: async (url) => {
      calls.postUrl.push(url)
      return { data: { transaction: { transactionListId: 'RES-9' } } }
    },
    pollJson: async (url) => {
      calls.pollUrl.push(url)
      const body = pollSequence.length > 1 ? pollSequence.shift() : pollSequence[0]
      return { status: over.pollStatus ?? 200, body }
    },
    sleep: async (ms) => { calls.sleeps.push(ms) },
    ...over
  }
  return { deps, calls }
}

describe('isoDateOnly', () => {
  it('extracts the YYYY-MM-DD head; throws on a non-ISO value', () => {
    expect(isoDateOnly('2026-07-01')).toBe('2026-07-01')
    expect(isoDateOnly('2026-07-01T12:00:00+03:00')).toBe('2026-07-01')
    expect(() => isoDateOnly('01.07.2026')).toThrow(/not an ISO date/)
  })
})

describe('priorApiBaseFromEnv', () => {
  it('null without PRIOR_OAUTH_API_BASE; trims trailing slashes when set', () => {
    delete process.env.PRIOR_OAUTH_API_BASE
    expect(priorApiBaseFromEnv()).toBeNull()
    process.env.PRIOR_OAUTH_API_BASE = 'https://prior:9544/'
    try {
      expect(priorApiBaseFromEnv()).toBe('https://prior:9544')
    } finally {
      delete process.env.PRIOR_OAUTH_API_BASE
    }
  })
})

describe('fetchPriorStatement', () => {
  it('create → poll (ready) → normalizes to the SAME StatementItem[] as the pure normalizer', async () => {
    const { deps, calls } = fakeDeps()
    const items = await fetchPriorStatement(query, tok, deps)
    expect(items).toEqual(normalizePriorTransactionList(readyResponse(), { account: 'ACC-1' }))
    expect(items).toHaveLength(2)
    expect(calls.ensured).toBe(1) // refreshed before the call
    // The URLs address the bank's OPAQUE accountId (resolved from our stored IBAN) — NOT the IBAN.
    expect(calls.getUrl[0]).toContain('/open-banking/v1.0/accounts')
    expect(calls.postUrl[0]).toContain('/open-banking/v1.0/accounts/OPAQUE-9/transactions')
    expect(calls.pollUrl[0]).toContain('/open-banking/v1.0/accounts/OPAQUE-9/transactions/RES-9')
    expect(calls.postUrl[0]).not.toContain('/accounts/ACC-1/') // the IBAN is never a path id
  })

  it('normalizes against OUR stored account key, not the bank id (dedup keys stay stable)', async () => {
    const { deps } = fakeDeps()
    const items = await fetchPriorStatement(query, tok, deps)
    expect(items.every(i => i.account === 'ACC-1')).toBe(true)
  })

  it('polls again while pending (BY.NBRB.Resource.NotCreated), then normalizes when ready', async () => {
    const { deps, calls } = fakeDeps({ pollSequence: [pendingResponse, pendingResponse, readyResponse()] })
    const items = await fetchPriorStatement(query, tok, deps)
    expect(items).toHaveLength(2)
    expect(calls.pollUrl).toHaveLength(3) // two pending + one ready
    expect(calls.sleeps).toHaveLength(2) // waited between the pending polls
  })

  it('follows links.next through the LIVE wiring — pages fetched via pollJson, notice via log', async () => {
    // ⚠ The walk units above exercise the loop in isolation; this covers the seam — a ready poll
    // body carrying `links.next` must make fetchPriorStatement request the second page over the
    // same pollJson transport and report the recovery through deps.log.
    const page2 = {
      data: { transaction: [{ transactionId: 'T-EXTRA', creditDebitIndicator: 'Credit', amount: 7, currency: 'BYN', bookingDateTime: '2026-07-01T10:00:00' }] },
      links: {}
    }
    const first = { ...readyResponse(), links: { next: '/open-banking/v1.0/accounts/OPAQUE-9/transactions/RES-9?page=2' } }
    const logged: string[] = []
    const { deps, calls } = fakeDeps({ pollSequence: [first, page2], log: line => logged.push(line) })
    const items = await fetchPriorStatement(query, tok, deps)
    expect(items.map(i => i.docId)).toContain('T-EXTRA')
    expect(calls.pollUrl.at(-1)).toBe('https://prior:9344/open-banking/v1.0/accounts/OPAQUE-9/transactions/RES-9?page=2')
    expect(logged.some(l => l.includes('ПАГИНАЦИЯ ВЕРНУЛА ЕЩЁ 1'))).toBe(true)
    // The notice rides the [prior-page] marker exactly once — the channel prefix is not doubled.
    expect(logged.filter(l => l.includes('ПАГИНАЦИЯ'))[0]).toMatch(/^\[prior-page\] /)
  })

  it('one page and no next — no extra polls, no pagination notice (the ordinary tick stays quiet)', async () => {
    const logged: string[] = []
    const { deps, calls } = fakeDeps({ log: line => logged.push(line) })
    await fetchPriorStatement(query, tok, deps)
    expect(calls.pollUrl).toHaveLength(1)
    expect(logged.some(l => l.includes('ПАГИНАЦИЯ') || l.includes('ОБОРВАН'))).toBe(false)
  })

  it('throws when the API base is not configured', async () => {
    const { deps } = fakeDeps({ apiBase: () => null })
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/PRIOR_OAUTH_API_BASE not configured/)
  })

  it('throws when the window exceeds the 93-day cap', async () => {
    const wide: BankFetchQuery = { ...query, dateFrom: '2026-01-01', dateTo: '2026-07-01' }
    const { deps } = fakeDeps()
    await expect(fetchPriorStatement(wide, tok, deps)).rejects.toThrow(/exceeds Priorbank/)
  })

  it('throws when create returns no resource id', async () => {
    const { deps } = fakeDeps({ postJson: async () => ({ data: {} }) })
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/create returned no transactions id/)
  })

  it('throws on a hard poll error (a non-NotCreated code)', async () => {
    const { deps } = fakeDeps({ pollSequence: [{ errors: [{ code: 'BY.NBRB.Field.InvalidDate' }] }] })
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/poll error.*InvalidDate/)
  })

  it('a 429 throttle is NEVER read as an empty statement — it retries, then fails loud', async () => {
    // The throttle body carries no Prior error codes; classifying by body alone would make this
    // "ready with zero transactions" and silently drop a window that had operations.
    const { deps, calls } = fakeDeps({ pollStatus: 429, pollSequence: [{ message: 'Too Many Requests' }] })
    // ⚠ Сообщение обязано НАЗЫВАТЬ троттл. Прежнее говорило только «не готово за N опросов», и по
    // нему нельзя было отличить «банк ещё считает» от «банк нас отшивает» — а лечатся они
    // противоположно: ждать дольше против ходить реже. Ночь на проде прошла ровно в этой слепоте.
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/[1-9]\d* throttled\/5xx, last HTTP 429/)
    // ⚠ Не ровно `PRIOR_POLL_MAX_ATTEMPTS`: опрос теперь ограничен ещё и ВРЕМЕНЕМ, и потолок
    // связывающий — он обрывает раньше, чем кончатся попытки. Важно здесь другое: 429 трактуется
    // как «ещё не ответ» и опрос ПОВТОРЯЕТСЯ много раз, а не считается пустой выпиской.
    expect(calls.pollUrl.length).toBeGreaterThan(5)
    expect(calls.pollUrl.length).toBeLessThanOrEqual(PRIOR_POLL_MAX_ATTEMPTS)
  })

  it('an UNRECOGNIZED 200 body (no data envelope, no error codes) fails loud, not as empty', async () => {
    const { deps } = fakeDeps({ pollSequence: [{ message: 'gateway blurb' }] })
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/unrecognized-response/)
  })

  it('throws when the stored account is not in the consent account list', async () => {
    const { deps } = fakeDeps({ getJson: async () => ({ data: { account: [{ accountId: 'X', accountDetails: { identification: 'OTHER' } }] } }) })
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/not found in the consent/)
  })

  it('throws after exhausting the poll budget (never ready)', async () => {
    const { deps, calls } = fakeDeps({ pollSequence: [pendingResponse] })
    // И симметрично: «ещё считает» обязано быть отличимо от троттла в самом тексте.
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/[1-9]\d* pending, 0 throttled/)
    expect(calls.pollUrl.length).toBeGreaterThan(5)
    expect(calls.pollUrl.length).toBeLessThanOrEqual(PRIOR_POLL_MAX_ATTEMPTS)
    // На одно ожидание меньше, чем опросов: после последнего опроса не спим.
    expect(calls.sleeps).toHaveLength(calls.pollUrl.length - 1)
  })
})

describe('isRetryablePollStatus', () => {
  it('429 and 5xx are "try again"; 2xx/other 4xx are not', () => {
    expect(isRetryablePollStatus(429)).toBe(true)
    expect(isRetryablePollStatus(503)).toBe(true)
    expect(isRetryablePollStatus(500)).toBe(true)
    expect(isRetryablePollStatus(200)).toBe(false)
    expect(isRetryablePollStatus(404)).toBe(false)
    expect(isRetryablePollStatus(403)).toBe(false)
  })
})

describe('resolvePriorAccountId', () => {
  const getJson = async (): Promise<unknown> => ACCOUNTS_RESPONSE
  it('maps our stored IBAN to the bank accountId (case-insensitive)', async () => {
    expect(await resolvePriorAccountId('https://p', 'ACC-1', 'T', { getJson })).toBe('OPAQUE-9')
    expect(await resolvePriorAccountId('https://p', 'acc-1', 'T', { getJson })).toBe('OPAQUE-9')
  })
  it('also accepts the accountId itself (admin may have entered it directly)', async () => {
    expect(await resolvePriorAccountId('https://p', 'OPAQUE-9', 'T', { getJson })).toBe('OPAQUE-9')
  })
  it('throws for an account outside the consent (never fetches someone else)', async () => {
    await expect(resolvePriorAccountId('https://p', 'NOPE', 'T', { getJson })).rejects.toThrow(/not found in the consent/)
  })
})

// #455 parity: the polling path carries a live Bearer on every cron tick, so it must apply the
// SAME address rules as the one-shot connect flow — validating only there would leave the frequent,
// automated traffic on a raw env value.
describe('priorApiBaseFromEnv — address rules (#455)', () => {
  const set = (v: string) => {
    process.env.PRIOR_OAUTH_API_BASE = v
  }
  afterEach(() => {
    process.env.PRIOR_OAUTH_API_BASE = ''
  })

  it('rejects http:// to a PUBLIC host (Bearer would cross the network in clear text)', () => {
    set('http://api.priorbank.by:9344')
    expect(priorApiBaseFromEnv()).toBeNull()
  })

  it('rejects a public domain that merely starts like a private range', () => {
    set('http://10.attacker.com')
    expect(priorApiBaseFromEnv()).toBeNull()
  })

  it('accepts http:// to the internal gateway (that is how the crypto gateway works)', () => {
    set('http://avtunproxy:1080')
    expect(priorApiBaseFromEnv()).toBe('http://avtunproxy:1080')
  })

  it('accepts https and strips trailing slashes', () => {
    set('https://api.priorbank.by:9344/')
    expect(priorApiBaseFromEnv()).toBe('https://api.priorbank.by:9344')
  })
})

describe('бюджет опроса ресурса (#522, замер на проде)', () => {
  it('задержка растёт и упирается в потолок', () => {
    // ⚠ Плоские 1500 мс на 8 попыток — это десять секунд на то, чтобы банк сгенерировал выписку за
    // три дня. На проде это не сработало НИ РАЗУ за ночь. Рост нужен и по второй причине: 429
    // считается «ещё не готово», и долбить жёсткий пер-аккаунтный троттл раз в 1,5 с — хороший
    // способ остаться затроттленным.
    expect(priorPollDelayMs(0)).toBe(PRIOR_POLL_DELAY_MS)
    expect(priorPollDelayMs(1)).toBeGreaterThan(priorPollDelayMs(0))
    expect(priorPollDelayMs(5)).toBeGreaterThan(priorPollDelayMs(2))
    // Потолок обязателен: без него задержка растёт экспоненциально и последняя попытка одна съедает
    // весь бюджет, ничего им не выиграв.
    expect(priorPollDelayMs(50)).toBe(PRIOR_POLL_MAX_DELAY_MS)
    expect(priorPollDelayMs(-3)).toBe(PRIOR_POLL_DELAY_MS) // отрицательная попытка не ломает арифметику
  })

  it('связывает ВРЕМЯ, а не число попыток — и ждём минуты, а не секунды', () => {
    let byAttempts = 0
    for (let i = 0; i < PRIOR_POLL_MAX_ATTEMPTS - 1; i++) byAttempts += priorPollDelayMs(i)
    // ⚠ Ограничитель по времени обязан быть СВЯЗЫВАЮЩИМ: попытки в одиночку разрешили бы больше,
    // значит именно потолок решает, когда остановиться. Иначе он недостижим при отгружаемых
    // константах — то есть непроверяем и молча перестанет защищать при первой же правке числа
    // попыток. Ровно это поймала мутация: с недостижимым потолком его удаление ничего не меняло.
    expect(byAttempts).toBeGreaterThan(PRIOR_POLL_BUDGET_MS)
    // Нижняя граница — то, ради чего правка: прежний бюджет был ~10 с и не хватал НИ РАЗУ за ночь.
    expect(PRIOR_POLL_BUDGET_MS).toBeGreaterThan(60_000)
    // Верхняя — слот воркера не занимается произвольно долго. Очередь Приора для того и отдельная,
    // но у «долго» тоже должен быть предел.
    expect(PRIOR_POLL_BUDGET_MS).toBeLessThanOrEqual(300_000)
  })

  it('потолок по ВРЕМЕНИ обрывает опрос раньше, чем кончатся попытки', async () => {
    // ⚠ Два независимых ограничителя намеренно: правка одной константы (числа попыток или
    // множителя) не должна уметь превратить задачу в бесконечно висящую.
    const { deps, calls } = fakeDeps({ pollSequence: [pendingResponse] })
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/waited/)
    const total = calls.sleeps.reduce((a, b) => a + b, 0)
    // Суммарное ожидание не выходит за потолок…
    expect(total).toBeLessThanOrEqual(PRIOR_POLL_BUDGET_MS)
    // …и оборвал опрос именно ОН, а не исчерпание попыток: снов строго меньше, чем попыток минус
    // одна (последняя попытка не спит и без всякого потолка). ⚠ Без этой проверки потолок был бы
    // недостижим при отгружаемых константах — мутация «снять потолок» выживала, потому что он
    // никогда не срабатывал. Бюджет подобран так, чтобы он был СВЯЗЫВАЮЩИМ.
    expect(calls.sleeps.length).toBeLessThan(PRIOR_POLL_MAX_ATTEMPTS - 1)
    for (const ms of calls.sleeps) expect(ms).toBeLessThanOrEqual(PRIOR_POLL_MAX_DELAY_MS)
  })

  it('успешный опрос печатает, СКОЛЬКО ждали — иначе бюджет калибруется гаданием', () => {
    // Именно гадание и дало десять секунд. Реальная длительность известна ровно в одном месте.
    const src = readFileSync(join(import.meta.dirname, '..', 'server/utils/priorFetch.ts'), 'utf8')
    expect(src).toMatch(/\[prior-poll\] ready after/)
    expect(src).toMatch(/deps\.log\?\.\(/)
  })
})

describe('подозрение на страничный лимит (#522, живой прогон 2026-08-20)', () => {
  it('круглые размеры страниц опознаются, обычные — нет', () => {
    // ⚠ Живой опрос вернул РОВНО 100 операций двенадцать раз подряд. Пагинации нет ни в запросе,
    // ни в разборе ответа, поэтому проверить по коду нечего: `meta`/`links`, если банк их шлёт,
    // отбрасываются типом «минимальная форма». Цена ошибки несимметрична — потерянные платежи
    // молчаливы, а лог при этом говорит «100 ops» и выглядит здоровым.
    for (const n of [50, 100, 200, 500, 1000]) expect(looksLikePageBoundary(n)).toBe(true)
    for (const n of [0, 1, 99, 101, 137, 999]) expect(looksLikePageBoundary(n)).toBe(false)
  })

  it('перечисляет ИМЕНА непрочитанных полей конверта', () => {
    // Это и есть улика: если банк шлёт пагинацию, она окажется здесь на первом же опросе.
    const keys = unreadEnvelopeKeys({
      data: { accountId: 'A', transaction: [], totalCount: 350 },
      meta: { page: 1 },
      links: { next: 'https://…' }
    })
    expect(keys).toContain('meta')
    expect(keys).toContain('links')
    expect(keys).toContain('data.totalCount')
    // Прочитанные поля в улики не попадают — иначе строка шумит на каждом здоровом ответе.
    expect(keys).not.toContain('data')
    expect(keys).not.toContain('data.transaction')
    expect(keys).not.toContain('data.accountId')
  })

  it('⚠ значения НЕ печатаются — только имена', () => {
    // Значения — финансовые ПДн (docs/PRIVACY.md). Строка идёт в общий лог контейнера.
    const keys = unreadEnvelopeKeys({ data: { transaction: [] }, secret: 'BY26PJCB301206990710000009 33' })
    expect(keys).toEqual(['secret'])
    expect(keys.join(' ')).not.toMatch(/BY26/)
  })

  it('мусор вместо объекта не роняет разбор', () => {
    for (const bad of [null, undefined, 'строка', 42, []]) expect(unreadEnvelopeKeys(bad)).toEqual([])
  })

  it('предупреждение печатается ТОЛЬКО на подозрительном количестве', async () => {
    // Иначе строка шумит на каждом опросе и перестаёт читаться — ровно та беда, из-за которой
    // построчный лог операций пришлось прижимать (#498).
    const lines: string[] = []
    const mk = (n: number) => fakeDeps({
      pollSequence: [{ data: { accountId: 'ACC-1', transaction: Array.from({ length: n }, (_, i) => ({
        transactionId: `t${i}`, creditDebitIndicator: 'Credit', amount: 1, currency: 'BYN',
        transactionDetails: 'оплата', bookingDateTime: '2026-07-02T10:00:00+03:00', debtor: { name: 'ООО Ромашка' }
      })) } }]
    })
    const a = mk(3)
    await fetchPriorStatement(query, tok, { ...a.deps, log: l => lines.push(l) })
    expect(lines.some(l => l.includes('[prior-page]'))).toBe(false)
    lines.length = 0
    const b = mk(100)
    await fetchPriorStatement(query, tok, { ...b.deps, log: l => lines.push(l) })
    expect(lines.some(l => l.includes('[prior-page]'))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #561: Prior transaction-list page walking (`links.next`).
//
// Measured on production 2026-08-22: every tick returned EXACTLY 100 operations for the window,
// with unread `links`/`meta` sitting in the envelope — the same silent truncation #561 chased on
// Alfa, but with the pagination pointer right there in the response.
// ─────────────────────────────────────────────────────────────────────────────
describe('#561: priorNextPageUrl', () => {
  const BASE = 'https://api.priorbank.by:9344'

  it('reads links.next as a string or an {href} object, resolved against our base', () => {
    expect(priorNextPageUrl({ links: { next: '/openbanking/v1/x?page=2' } }, BASE))
      .toBe(`${BASE}/openbanking/v1/x?page=2`)
    expect(priorNextPageUrl({ links: { next: { href: `${BASE}/x?page=2` } } }, BASE))
      .toBe(`${BASE}/x?page=2`)
  })

  it('refuses a cross-origin next — the Bearer never follows bank-supplied text off our origin', () => {
    expect(priorNextPageUrl({ links: { next: 'https://evil.example/x' } }, BASE)).toBeNull()
    expect(priorNextPageUrl({ links: { next: 'http://api.priorbank.by:9344/x' } }, BASE)).toBeNull()
    expect(priorNextPageUrl({ links: { next: `${BASE.replace('9344', '9345')}/x` } }, BASE)).toBeNull()
  })

  it('absent/blank/malformed next reads as no next', () => {
    expect(priorNextPageUrl({ links: {} }, BASE)).toBeNull()
    expect(priorNextPageUrl({ links: { next: '  ' } }, BASE)).toBeNull()
    expect(priorNextPageUrl({ links: { next: 7 } }, BASE)).toBeNull()
    expect(priorNextPageUrl({}, BASE)).toBeNull()
    expect(priorNextPageUrl(null, BASE)).toBeNull()
  })
})

describe('#561: walkPriorPages', () => {
  const BASE = 'https://api.priorbank.by:9344'
  const nowait = { sleep: async () => {} }
  const tx = (id: string) => ({
    transactionId: id, creditDebitIndicator: 'Credit', amount: 10, currency: 'BYN',
    transactionDetails: 'p', bookingDateTime: '2026-08-21T10:00:00',
    debtor: { name: 'n' }, debtorAccount: { identification: 'BY99X' }
  })
  const page = (ids: string[], next?: string) => ({
    data: { transaction: ids.map(tx) },
    links: next === undefined ? {} : { next }
  })

  it('follows links.next and recovers rows the single-page version was losing', async () => {
    const pages: Record<string, unknown> = {
      [`${BASE}/p2`]: page(['c', 'd'], '/p3'),
      [`${BASE}/p3`]: page(['e'])
    }
    const fetchPage = vi.fn(async (url: string) => ({ status: 200, body: pages[url]! }))
    const onWalk = vi.fn()
    const out = await walkPriorPages(page(['a', 'b'], '/p2'), 'ACC', BASE, fetchPage, onWalk, nowait)
    expect(out.map(i => i.docId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(onWalk).toHaveBeenCalledWith({ pages: 3, recovered: 3, stop: 'exhausted' })
    expect(priorWalkNotice('acc', onWalk.mock.calls[0]![0])).toContain('ПАГИНАЦИЯ ВЕРНУЛА ЕЩЁ 3')
  })

  it('no next link — one page, no extra requests, silence', async () => {
    const fetchPage = vi.fn()
    const onWalk = vi.fn()
    const out = await walkPriorPages(page(['a']), 'ACC', BASE, fetchPage, onWalk, nowait)
    expect(out).toHaveLength(1)
    expect(fetchPage).not.toHaveBeenCalled()
    expect(onWalk).toHaveBeenCalledWith({ pages: 1, recovered: 0, stop: 'exhausted' })
    expect(priorWalkNotice('acc', onWalk.mock.calls[0]![0])).toBeNull()
  })

  it('a repeating raw page means the bank looped — stop quietly, nothing doubles', async () => {
    const same = page(['a', 'b'], '/p2')
    const fetchPage = vi.fn(async () => ({ status: 200, body: same }))
    const onWalk = vi.fn()
    const out = await walkPriorPages(same, 'ACC', BASE, fetchPage, onWalk, nowait)
    expect(out).toHaveLength(2)
    expect(onWalk).toHaveBeenCalledWith({ pages: 2, recovered: 0, stop: 'repeat' })
  })

  it('a page that dedups to nothing must NOT end the walk (the #566 regression, not repeated here)', async () => {
    // Two DIFFERENT payers colliding on the empty-docId content signature: raw pages differ, so the
    // walk continues; the output collapses the collision — all dedup can safely do.
    const anon = (name: string) => ({
      transactionId: '', creditDebitIndicator: 'Credit', amount: 5, currency: 'BYN',
      transactionDetails: 'same purpose', bookingDateTime: '2026-08-21T10:00:00',
      debtor: { name }, debtorAccount: { identification: 'BY99SAME' }
    })
    const pages: Record<string, unknown> = {
      [`${BASE}/p2`]: { data: { transaction: [anon('Петров')] }, links: { next: '/p3' } },
      [`${BASE}/p3`]: page(['real'])
    }
    const fetchPage = vi.fn(async (url: string) => ({ status: 200, body: pages[url]! }))
    const out = await walkPriorPages(
      { data: { transaction: [anon('Иванов')] }, links: { next: '/p2' } },
      'ACC', BASE, fetchPage, undefined, nowait
    )
    expect(fetchPage).toHaveBeenCalledTimes(2) // page 3 was still requested
    expect(out.map(i => i.docId)).toEqual(['', 'real'])
  })

  it('a cross-origin next stops LOUDLY — refused is not the same as absent', async () => {
    const onWalk = vi.fn()
    await walkPriorPages(page(['a'], 'https://evil.example/x'), 'ACC', BASE, vi.fn(), onWalk, nowait)
    expect(onWalk).toHaveBeenCalledWith({ pages: 1, recovered: 0, stop: 'foreign-next' })
    expect(priorWalkNotice('acc', onWalk.mock.calls[0]![0])).toContain('ЧУЖОЙ origin')
  })

  it('a throttled next page stops loudly instead of failing the job — the next tick self-heals', async () => {
    const fetchPage = vi.fn(async () => ({ status: 429, body: null }))
    const onWalk = vi.fn()
    const out = await walkPriorPages(page(['a'], '/p2'), 'ACC', BASE, fetchPage, onWalk, nowait)
    expect(out).toHaveLength(1)
    expect(onWalk).toHaveBeenCalledWith({ pages: 1, recovered: 0, stop: 'not-ready' })
    expect(priorWalkNotice('acc', onWalk.mock.calls[0]![0])).toContain('ОБХОД СТРАНИЦ ОБОРВАН')
  })

  it('a page ERROR throws — a broken answer is not a slow one', async () => {
    // The unrecognized-response shape is the honest fixture: a 400 body without our data envelope
    // classifies as an error either way, and the message must carry the page number.
    const fetchPage = vi.fn(async () => ({ status: 400, body: { nonsense: true } }))
    await expect(walkPriorPages(page(['a'], '/p2'), 'ACC', BASE, fetchPage, undefined, nowait))
      .rejects.toThrow(/page 2 error .*HTTP 400/)
  })

  it('endless distinct pages stop at the cap — and say it truncated', async () => {
    let n = 0
    const fetchPage = vi.fn(async () => ({ status: 200, body: page([`x${n++}`], '/next') }))
    const onWalk = vi.fn()
    await walkPriorPages(page(['x-first'], '/next'), 'ACC', BASE, fetchPage, onWalk, nowait)
    const info = onWalk.mock.calls[0]![0] as { pages: number, stop: string }
    expect(info.stop).toBe('page-cap')
    expect(info.pages).toBe(MAX_PRIOR_STATEMENT_PAGES)
    expect(priorWalkNotice('acc', onWalk.mock.calls[0]![0])).toContain(`потолок ${MAX_PRIOR_STATEMENT_PAGES} страниц`)
  })

  it('a slow bank stops on the wall-clock budget', async () => {
    let clock = 0
    const now = () => (clock += 9_000)
    let n = 0
    const fetchPage = vi.fn(async () => ({ status: 200, body: page([`y${n++}`], '/next') }))
    const onWalk = vi.fn()
    await walkPriorPages(page(['y-first'], '/next'), 'ACC', BASE, fetchPage, onWalk, { sleep: async () => {}, now })
    expect((onWalk.mock.calls[0]![0] as { stop: string }).stop).toBe('time-cap')
  })

  it('waits between pages, and only between them', async () => {
    const sleep = vi.fn(async (_ms: number) => {})
    const pages: Record<string, unknown> = { [`${BASE}/p2`]: page(['b']) }
    await walkPriorPages(page(['a'], '/p2'), 'ACC', BASE, async url => ({ status: 200, body: pages[url]! }), undefined, { sleep })
    expect(sleep.mock.calls.map(c => c[0])).toEqual([PRIOR_PAGE_DELAY_MS])
  })

  it('the caps are pinned and both reachable — neither is decoration', () => {
    expect(MAX_PRIOR_STATEMENT_PAGES).toBe(20)
    expect((MAX_PRIOR_STATEMENT_PAGES - 1) * PRIOR_PAGE_DELAY_MS).toBeLessThan(PRIOR_WALK_BUDGET_MS)
  })
})
