import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  ALFA_PAGE_DELAY_MS,
  ALFA_WALK_BUDGET_MS,
  alfaStatementQuery,
  alfaWalkNotice,
  bankApiConfig,
  bankFetchError,
  fetchAlfaStatementPages,
  fetchBankStatement,
  isBankUnauthorized,
  isoToAlfaDate,
  REAUTH_PAUSE_MAX_MS,
  REAUTH_PAUSE_MIN_MS,
  reauthPauseMs,
  MAX_ALFA_STATEMENT_PAGES,
  type BankFetchDeps,
  type BankFetchQuery
} from '../server/utils/bankFetch'
import { demoAlfaResponse } from '../app/utils/demoExtract'
import { normalizeAlfa } from '../app/utils/alfaStatement'
import type { BankToken } from '../server/utils/bankTokenStore'

const tok: BankToken = {
  memberId: 'm1', provider: 'alfa-by', accountKey: 'BY-ACC',
  accessToken: 'ACCESS', refreshToken: 'R', expiresAt: 9_999_999_999_999
}
const query: BankFetchQuery = { memberId: 'm1', provider: 'alfa-by', account: 'BY-ACC', dateFrom: '2026-07-01', dateTo: '2026-07-31' }

function fakeDeps(over: Partial<BankFetchDeps> & { stored?: BankToken | null, raw?: unknown } = {}) {
  const calls = { getUrl: [] as string[], getToken: [] as string[], ensured: 0 }
  const deps: BankFetchDeps = {
    loadToken: async () => (over.stored === undefined ? tok : over.stored),
    ensureFresh: async (t) => {
      // Mint a DISTINGUISHABLE fresh token so a test can prove the freshened (not stored)
      // access token is what reaches getJson — the whole point of the A4 ensure step.
      calls.ensured++
      return { ...t, accessToken: 'FRESH' }
    },
    apiConfig: () => ({ base: 'https://alfa:8273', statementPath: '/partner/1.2.0/accounts/statement' }),
    fetchPrior: async () => [],
    getJson: async (url, accessToken) => {
      calls.getUrl.push(url)
      calls.getToken.push(accessToken)
      return over.raw ?? demoAlfaResponse()
    },
    ...over
  }
  return { deps, calls }
}

describe('isoToAlfaDate', () => {
  it('converts ISO YYYY-MM-DD (or full ISO) to DD.MM.YYYY', () => {
    expect(isoToAlfaDate('2026-07-01')).toBe('01.07.2026')
    expect(isoToAlfaDate('2026-12-31T00:00:00.000Z')).toBe('31.12.2026')
  })
  it('throws on a non-ISO value (bad window fails loud, not fetches garbage)', () => {
    expect(() => isoToAlfaDate('01/07/2026')).toThrow(/not an ISO date/)
    expect(() => isoToAlfaDate('')).toThrow()
  })
})

describe('alfaStatementQuery', () => {
  it('builds number + DD.MM.YYYY window + all-transactions single page', () => {
    const q = alfaStatementQuery('BY-ACC', '2026-07-01', '2026-07-31')
    expect(q.get('number')).toBe('BY-ACC')
    expect(q.get('dateFrom')).toBe('01.07.2026')
    expect(q.get('dateTo')).toBe('31.07.2026')
    expect(q.get('transactions')).toBe('0')
    expect(q.get('pageNo')).toBe('0')
    expect(q.get('pageRowCount')).toBe('0')
  })
})

describe('bankFetchError', () => {
  it('builds a clean top-level message and preserves the cause chain', () => {
    const raw = Object.assign(new Error('Forbidden'), { status: 403 })
    const wrapped = bankFetchError(raw)
    expect(wrapped.message).toBe('bankFetch GET failed: 403 Forbidden')
    expect(wrapped.cause).toBe(raw) // the offending FetchError (Bearer) survives only in the deep cause
  })
  it('tolerates a non-Error / status-less throw', () => {
    expect(bankFetchError('boom').message).toBe('bankFetch GET failed: error')
  })
})

describe('bankApiConfig', () => {
  it('alfa: null without ALFA_OAUTH_API_BASE; builds base+path when set', () => {
    delete process.env.ALFA_OAUTH_API_BASE
    expect(bankApiConfig('alfa-by')).toBeNull()
    process.env.ALFA_OAUTH_API_BASE = 'https://alfa:8273/'
    try {
      expect(bankApiConfig('alfa-by')).toEqual({ base: 'https://alfa:8273', statementPath: '/partner/1.2.0/accounts/statement' })
    } finally {
      delete process.env.ALFA_OAUTH_API_BASE
    }
  })
  it('alfa: honours ALFA_OAUTH_API_PREFIX and normalises stray slashes (base//, prefix w/o leading /)', () => {
    process.env.ALFA_OAUTH_API_BASE = 'https://alfa:8273//'
    process.env.ALFA_OAUTH_API_PREFIX = 'partner/2.0/' // no leading slash, trailing slash
    try {
      expect(bankApiConfig('alfa-by')).toEqual({ base: 'https://alfa:8273', statementPath: '/partner/2.0/accounts/statement' })
    } finally {
      delete process.env.ALFA_OAUTH_API_BASE
      delete process.env.ALFA_OAUTH_API_PREFIX
    }
  })
  it('prior: null without PRIOR_OAUTH_API_BASE; builds /accounts when set', () => {
    delete process.env.PRIOR_OAUTH_API_BASE
    expect(bankApiConfig('prior-by')).toBeNull()
    process.env.PRIOR_OAUTH_API_BASE = 'https://prior:9544/'
    try {
      expect(bankApiConfig('prior-by')).toEqual({ base: 'https://prior:9544', statementPath: '/accounts' })
    } finally {
      delete process.env.PRIOR_OAUTH_API_BASE
    }
  })
  it('manual → null', () => {
    expect(bankApiConfig('manual')).toBeNull()
  })

  // ОБА банка судятся одним правилом (#455): база несёт Bearer на каждом тике опроса, поэтому
  // опечатка в схеме должна отключать выборку, а не отправлять токен открытым текстом.
  it.each([
    ['alfa-by', 'ALFA_OAUTH_API_BASE'],
    ['prior-by', 'PRIOR_OAUTH_API_BASE']
  ] as const)('%s: http на публичный хост → null (токен не уйдёт в открытую)', (provider, key) => {
    process.env[key] = 'http://bank.example.com:8273'
    try {
      expect(bankApiConfig(provider)).toBeNull()
    } finally {
      process.env[key] = ''
    }
  })

  it.each([
    ['alfa-by', 'ALFA_OAUTH_API_BASE'],
    ['prior-by', 'PRIOR_OAUTH_API_BASE']
  ] as const)('%s: http на ВНУТРЕННИЙ шлюз допустим', (provider, key) => {
    process.env[key] = 'http://crypto-gw:1080'
    try {
      expect(bankApiConfig(provider)?.base).toBe('http://crypto-gw:1080')
    } finally {
      process.env[key] = ''
    }
  })
})

describe('fetchBankStatement', () => {
  it('Alfa: fetches + normalizes the demo-wire fixture to the SAME StatementItem[] as the pure normalizer', async () => {
    const { deps, calls } = fakeDeps()
    const items = await fetchBankStatement(query, deps)
    // The transport map (wire → StatementItem[]) must equal the tested pure normalizer.
    expect(items).toEqual(normalizeAlfa(demoAlfaResponse(), { account: 'BY-ACC' }))
    expect(items.length).toBeGreaterThan(0)
    expect(calls.ensured).toBe(1) // token freshened before the call
    expect(calls.getToken[0]).toBe('FRESH') // the FRESHENED token — not the stored one — is sent
    // request went to the statement path with the full date window (Bearer is a header, not the URL)
    expect(calls.getUrl[0]).toContain('/partner/1.2.0/accounts/statement?')
    expect(calls.getUrl[0]).toContain('number=BY-ACC')
    expect(calls.getUrl[0]).toContain('dateFrom=01.07.2026')
    expect(calls.getUrl[0]).toContain('dateTo=31.07.2026')
  })

  it('no stored token → [] (inert, does not throw or fetch)', async () => {
    const getJson = vi.fn(async () => demoAlfaResponse())
    const { deps } = fakeDeps({ stored: null, getJson })
    expect(await fetchBankStatement(query, deps)).toEqual([])
    expect(getJson).not.toHaveBeenCalled()
  })

  it('Alfa per-account errors[] → THROWS (errored empty page is NOT "no operations")', async () => {
    const { deps } = fakeDeps({ raw: { page: [], errors: [{ number: 'BY-ACC', message: 'token expired' }] } })
    await expect(fetchBankStatement(query, deps)).rejects.toThrow(/returned errors — token expired/)
  })

  it('API base not configured → throws (not a silent [])', async () => {
    const { deps } = fakeDeps({ apiConfig: () => null })
    await expect(fetchBankStatement(query, deps)).rejects.toThrow(/API base not configured/)
  })

  it('Prior: delegates to the async create+poll engine (fetchPrior) with the query + stored token', async () => {
    const priorQ: BankFetchQuery = { ...query, provider: 'prior-by', account: 'PRIOR-ACC' }
    const priorTok: BankToken = { ...tok, provider: 'prior-by', accountKey: 'PRIOR-ACC' }
    const priorItems = [{ account: 'PRIOR-ACC', docId: 't1', direction: 'credit', amount: 5, currency: 'BYN', purpose: '', counterparty: { name: 'X', unp: '', account: '' }, acceptDate: '2026-07-01' }]
    const fetchPrior = vi.fn(async (_q: BankFetchQuery, _stored: BankToken) => priorItems as never)
    const { deps } = fakeDeps({ stored: priorTok, apiConfig: () => ({ base: 'https://prior', statementPath: '/accounts' }), fetchPrior })
    const items = await fetchBankStatement(priorQ, deps)
    expect(items).toEqual(priorItems)
    expect(fetchPrior).toHaveBeenCalledOnce()
    expect(fetchPrior.mock.calls[0]![0]).toEqual(priorQ) // the query
    expect(fetchPrior.mock.calls[0]![1]).toEqual(priorTok) // the stored token
  })

  it('unsupported provider (no online path) → throws (never a silent empty)', async () => {
    const manualQ: BankFetchQuery = { ...query, provider: 'manual' }
    const manualTok: BankToken = { ...tok, provider: 'manual' }
    const { deps } = fakeDeps({ stored: manualTok, apiConfig: () => ({ base: 'https://x', statementPath: '/y' }) })
    await expect(fetchBankStatement(manualQ, deps)).rejects.toThrow(/online fetch not supported/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #561: Alfa statement page walking.
//
// Prompted by a measurement, not a suspicion: a single day came back with EXACTLY 100 operations on
// five separate days, with true zeros on the two days between. There is no cap on our side anywhere
// along bank→parse→crm-sync, so the hundred comes from the bank. `pageRowCount: '0'` is documented
// as «все», but that is a line in a PDF, not a measurement, and we never read a page marker back —
// so if `0` means «default page», we were losing everything past the hundred every single day and
// could not have known.
//
// ⚠ These tests cover BOTH readings, because the loop has to be safe without knowing which is true.
// ─────────────────────────────────────────────────────────────────────────────
describe('#561: fetchAlfaStatementPages', () => {
  const row = (docId: string) => ({
    number: 'BY01', operType: 'C', amount: 10, currIso: 'BYN',
    purpose: 'p', corrName: 'n', corrNumber: 'BY99',
    docId, docNum: docId, operDate: '13.01.2026', acceptDate: '2026-01-13T14:00:00.000'
  })
  const page = (ids: string[]) => ({ page: ids.map(row), errors: [] })
  /** No real waiting in tests — the walk sleeps between pages in production. */
  const nowait = { sleep: async () => {} }

  it('reading A («0» means all): page 1 repeats — one extra request, and we stay quiet', async () => {
    // The bank ignores pageNo and returns the same set. Without dedup this would be a duplicate storm.
    const all = page(['a', 'b', 'c'])
    const fetchPage = vi.fn(async () => all)
    const onWalk = vi.fn()
    const out = await fetchAlfaStatementPages('BY01', fetchPage, onWalk, nowait)
    expect(out).toHaveLength(3)
    expect(fetchPage).toHaveBeenCalledTimes(2) // page 0 + one probe
    expect(onWalk).toHaveBeenCalledWith({ pages: 2, recovered: 0, stop: 'repeat' })
    expect(alfaWalkNotice('acc', onWalk.mock.calls[0]![0])).toBeNull() // nothing to recover ⇒ no noise
  })

  it('reading B («0» means one page): we take what used to vanish, and say so LOUDLY', async () => {
    const pages = [page(['a', 'b']), page(['c', 'd']), page([])]
    const fetchPage = vi.fn(async (n: number) => pages[n]!)
    const onWalk = vi.fn()
    const out = await fetchAlfaStatementPages('BY01', fetchPage, onWalk, nowait)
    expect(out.map(i => i.docId)).toEqual(['a', 'b', 'c', 'd'])
    // ⚠ A silent recovery would be worse than the loss: it would hide how long it had been going on.
    expect(onWalk).toHaveBeenCalledWith({ pages: 3, recovered: 2, stop: 'exhausted' })
    expect(alfaWalkNotice('acc', onWalk.mock.calls[0]![0])?.text).toContain('со 2-й и дальше добрано операций: 2')
  })

  it('an empty first page costs exactly one request and no waiting', async () => {
    const sleep = vi.fn(async () => {})
    const fetchPage = vi.fn(async () => page([]))
    const out = await fetchAlfaStatementPages('BY01', fetchPage, undefined, { sleep })
    expect(out).toEqual([])
    expect(fetchPage).toHaveBeenCalledTimes(1)
    // A quiet day is the common case — it must not pay the courtesy gap.
    expect(sleep).not.toHaveBeenCalled()
  })

  it('waits between pages, and only between them', async () => {
    // ⚠ The parameter is DECLARED, not inferred away: a `vi.fn(async () => {})` double cannot see
    // the argument it is called with, so `mock.calls[i][0]` types as never and the assertion below
    // would be checking nothing (the #565 lesson, one layer down).
    const sleep = vi.fn(async (_ms: number) => {})
    const pages = [page(['a']), page(['b']), page([])]
    await fetchAlfaStatementPages('BY01', async (n: number) => pages[n]!, undefined, { sleep })
    // 3 fetches, 2 gaps — the walk never sleeps after the page that ends it.
    expect(sleep.mock.calls.map(c => c[0])).toEqual([ALFA_PAGE_DELAY_MS, ALFA_PAGE_DELAY_MS])
  })

  it('partial overlap between pages neither doubles nor loses', async () => {
    // Window shifted between requests — the bank re-sent the tail of the previous page.
    // ⚠ Note page 2 (`['c']`, wholly seen already) does NOT end the walk: only an empty page or a
    // repeat of a raw page we already fetched does. Under the old dedup-based stop this fixture
    // ended one request early, which is harmless here and catastrophic when page 3 has data.
    const pages = [page(['a', 'b']), page(['b', 'c']), page(['c']), page([])]
    const fetchPage = vi.fn(async (n: number) => pages[n]!)
    const out = await fetchAlfaStatementPages('BY01', fetchPage, undefined, nowait)
    expect(out.map(i => i.docId)).toEqual(['a', 'b', 'c'])
    expect(fetchPage).toHaveBeenCalledTimes(4)
  })

  it('duplicates INSIDE one page collapse in the output without ending the walk', async () => {
    const pages = [{ page: [row('a'), row('a'), row('b')], errors: [] }, page(['c']), page([])]
    const onWalk = vi.fn()
    const out = await fetchAlfaStatementPages('BY01', async (n: number) => pages[n]!, onWalk, nowait)
    expect(out.map(i => i.docId)).toEqual(['a', 'b', 'c'])
    expect(onWalk).toHaveBeenCalledWith({ pages: 3, recovered: 1, stop: 'exhausted' })
  })

  it('a page that dedups to nothing must NOT end the walk (the regression this stop condition exists for)', async () => {
    // ⚠ THE CASE THAT MAKES THE STOP CONDITION READ RAW ROWS. `dedupKey` falls back to a content
    // signature when `docId` is empty, and that signature does NOT include the payer's NAME — so two
    // DIFFERENT payers with the same amount, batch acceptDate, template purpose and recipient account
    // collide. On the old single-request path that cost one operation. As a stop condition it would
    // end the walk here and cost every remaining page — exactly the silent mass loss #561 is about.
    const anon = (corrName: string) => ({ ...row(''), corrName })
    const pages = [
      { page: [anon('Иванов')], errors: [] },
      { page: [anon('Петров')], errors: [] }, // collides with page 0 ⇒ dedups to nothing
      { page: [row('real')], errors: [] }, // ...and this must still be requested
      page([])
    ]
    const fetchPage = vi.fn(async (n: number) => pages[n]!)
    const out = await fetchAlfaStatementPages('BY01', fetchPage, undefined, nowait)
    expect(fetchPage).toHaveBeenCalledTimes(4)
    expect(out.map(i => i.docId)).toEqual(['', 'real'])
  })

  it('a bank error on ANY page fails the fetch — an errored response is not «no operations»', async () => {
    const fetchPage = vi.fn(async (n: number) =>
      n === 0 ? page(['a']) : { page: [], errors: [{ message: 'token expired' }] })
    await expect(fetchAlfaStatementPages('BY01', fetchPage, undefined, nowait)).rejects.toThrow(/token expired/)
  })

  it('errors AND rows on the same page still fail — a partial page is not the end of the data', async () => {
    const fetchPage = vi.fn(async () => ({ page: [row('a')], errors: [{ message: 'partial' }] }))
    await expect(fetchAlfaStatementPages('BY01', fetchPage, undefined, nowait)).rejects.toThrow(/partial/)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('endless distinct output stops at the page cap — and says it truncated', async () => {
    let n = 0
    const fetchPage = vi.fn(async () => page([`x${n++}`])) // a NEW id every time
    const onWalk = vi.fn()
    const out = await fetchAlfaStatementPages('BY01', fetchPage, onWalk, nowait)
    expect(fetchPage).toHaveBeenCalledTimes(MAX_ALFA_STATEMENT_PAGES)
    expect(out).toHaveLength(MAX_ALFA_STATEMENT_PAGES)
    // ⚠ Hitting the ceiling must be DISTINGUISHABLE from running out of data, or #561 comes back one
    // layer up: the truncation just moves from 100 operations to 20 pages and nobody hears about it.
    expect(onWalk).toHaveBeenCalledWith({ pages: MAX_ALFA_STATEMENT_PAGES, recovered: MAX_ALFA_STATEMENT_PAGES - 1, stop: 'page-cap' })
    expect(alfaWalkNotice('acc', onWalk.mock.calls[0]![0])?.text).toContain('ОБХОД СТРАНИЦ ОБОРВАН')
  })

  it('a slow bank stops on the wall-clock budget, before the page cap', async () => {
    // 20 pages × a 20 s response is 400 s — a job that long holds a worker slot across cron ticks.
    let clock = 0
    const now = () => (clock += 8_000) // each check advances the clock by 8 s
    let n = 0
    const fetchPage = vi.fn(async () => page([`y${n++}`]))
    const onWalk = vi.fn()
    await fetchAlfaStatementPages('BY01', fetchPage, onWalk, { sleep: async () => {}, now })
    const info = onWalk.mock.calls[0]![0] as { pages: number, stop: string }
    expect(info.stop).toBe('time-cap')
    expect(info.pages).toBeLessThan(MAX_ALFA_STATEMENT_PAGES)
    expect(alfaWalkNotice('acc', onWalk.mock.calls[0]![0])?.text).toContain('ОБХОД СТРАНИЦ ОБОРВАН')
  })

  it('the page cap and the time budget are BOTH reachable — neither is decoration', () => {
    // ⚠ Pinned deliberately: a budget the shipped configuration can never reach cannot be tested and
    // silently stops protecting anything the moment someone retunes the other knob (the lesson
    // PRIOR_POLL_BUDGET_MS already carries). Fast bank ⇒ the count binds; slow bank ⇒ the clock does.
    expect(MAX_ALFA_STATEMENT_PAGES).toBe(20)
    expect((MAX_ALFA_STATEMENT_PAGES - 1) * ALFA_PAGE_DELAY_MS).toBeLessThan(ALFA_WALK_BUDGET_MS)
  })

  it('the first request is identical to the old one — production does not change', () => {
    // ⚠ Regression anchor: pageNo=0 must produce the same string as before the change.
    expect(alfaStatementQuery('BY01', '2026-01-13', '2026-01-13').toString())
      .toBe(alfaStatementQuery('BY01', '2026-01-13', '2026-01-13', 0).toString())
    expect(alfaStatementQuery('BY01', '2026-01-13', '2026-01-13').toString()).toContain('pageNo=0')
    expect(alfaStatementQuery('BY01', '2026-01-13', '2026-01-13').toString()).toContain('pageRowCount=0')
  })
})

describe('#561: alfaWalkNotice', () => {
  it('says nothing about the ordinary case', () => {
    expect(alfaWalkNotice('acc', { pages: 2, recovered: 0, stop: 'repeat' })).toBeNull()
    expect(alfaWalkNotice('acc', { pages: 1, recovered: 0, stop: 'exhausted' })).toBeNull()
  })

  it('carries no literal channel tag — the formatter already prints one', () => {
    // ⚠ `[fetch] WARNING: [fetch] …` is the duplication buildOpLogLine documents; do not rebuild it.
    const notice = alfaWalkNotice('alfa BY01 2026-01-13..2026-01-13', { pages: 3, recovered: 2, stop: 'exhausted' })!
    expect(notice.text).not.toContain('[fetch]')
    expect(notice.text).toContain('alfa BY01 2026-01-13..2026-01-13')
    // ⚠ Штатно собранные страницы — ФАКТ, а не тревога. Замечание владельца по живому логу: эта
    // строка печаталась WARNING на каждом тике исправной работы, то есть предупреждала о том, что
    // уже починено, и забивала поиск настоящих проблем.
    expect(notice.level, 'исправная пагинация снова кричит').toBe('info')
  })

  it('reports both facts at once when both happened', () => {
    const notice = alfaWalkNotice('acc', { pages: 20, recovered: 19, stop: 'page-cap' })!
    expect(notice.text).toContain('со 2-й и дальше добрано операций: 19')
    expect(notice.text).toContain('ОБХОД СТРАНИЦ ОБОРВАН на 20-й')
    expect(notice.text).toContain('потолок 20 страниц')
    // ⚠ Обрыв — ЕДИНСТВЕННАЯ тревога этого обхода: окно могло прийти не полностью.
    expect(notice.level).toBe('warn')
  })

  it('names the wall-clock budget when that is what stopped it', () => {
    const notice = alfaWalkNotice('acc', { pages: 6, recovered: 0, stop: 'time-cap' })!
    expect(notice.text).toContain(`бюджет ${Math.round(ALFA_WALK_BUDGET_MS / 1000)} с`)
    expect(notice.level).toBe('warn')
  })
})

describe('#561: fetchBankStatement page walking (live wiring)', () => {
  it('walks pageNo upward on the real URL and reports through deps.warn', async () => {
    // ⚠ The unit tests above exercise the loop in isolation; this one covers the seam — the growing
    // `pageNo` in the built URL and the warn channel — which no test touched before.
    const pages = [
      { page: [{ number: 'BY-ACC', operType: 'C', amount: 1, currIso: 'BYN', docId: 'a', acceptDate: '2026-07-01T10:00:00.000' }], errors: [] },
      { page: [{ number: 'BY-ACC', operType: 'C', amount: 2, currIso: 'BYN', docId: 'b', acceptDate: '2026-07-01T11:00:00.000' }], errors: [] },
      { page: [], errors: [] }
    ]
    let call = 0
    const warn = vi.fn()
    const seenUrls: string[] = []
    const info = vi.fn()
    const { deps } = fakeDeps({
      getJson: async (url: string) => {
        seenUrls.push(url)
        return pages[call++]!
      },
      warn,
      log: info
    })
    const out = await fetchBankStatement(query, deps)
    expect(out.map(i => i.docId)).toEqual(['a', 'b'])
    expect(seenUrls.map(u => /pageNo=(\d+)/.exec(u)![1])).toEqual(['0', '1', '2'])
    // ⚠ Штатно собранные страницы идут в СПОКОЙНЫЙ канал: на живом проде эта строка печаталась
    // предупреждением на каждом тике исправной работы (замечание владельца по логу 2026-08-23).
    expect(warn, 'исправная пагинация снова кричит').not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]![0]).toContain('со 2-й и дальше добрано операций: 1')
    expect(info.mock.calls[0]![0]).not.toContain('[fetch]')
  })

  it('stays silent on the ordinary poll', async () => {
    const warn = vi.fn()
    const { deps } = fakeDeps({ warn })
    await fetchBankStatement(query, deps)
    expect(warn).not.toHaveBeenCalled()
  })
})

// ⚠ ЖИВАЯ НАХОДКА 2026-09-09 (боевой лог). Три попытки подряд `401 Unauthorized` на
// `/accounts/statement` — и задача умерла окончательно. Переспросить токен было НЕКОМУ: `ensureFresh`
// решает по ЧАСАМ, а по часам токен был свежим; часовое продление рассудило так же (`selected=0
// refreshed=0`). Подключение вставало намертво в состоянии «формально живой токен, который банк не
// принимает», и само не чинилось никогда.
//
// ⚠ Это же состояние — единственная форма, в которой проявилось бы взаимное гашение ДВУХ порталов,
// подключённых ОДНИМ ключом API (второй ключ на тот же client_id банк не выдаёт).
describe('#488 отказ банка в токене: переспрашиваем и повторяем', () => {
  /** Ошибка в той форме, в какой её отдаёт живой транспорт: статус лежит в `cause`. */
  function unauthorized(): Error {
    return bankFetchError(Object.assign(new Error('401 Unauthorized'), { status: 401 }))
  }

  it('401 → force-переиздание → повтор проходит, страница собрана', async () => {
    let first = true
    const forced: (boolean | undefined)[] = []
    const tokens: string[] = []
    const { deps } = fakeDeps({
      ensureFresh: async (t, opts) => {
        forced.push(opts?.force)
        return { ...t, accessToken: opts?.force ? 'REISSUED' : 'FRESH' }
      },
      getJson: async (_url, accessToken) => {
        tokens.push(accessToken)
        if (first) {
          first = false
          throw unauthorized()
        }
        return demoAlfaResponse()
      }
    })
    const items = await fetchBankStatement(query, deps)
    expect(items.length).toBeGreaterThan(0)
    // Первый заход — обычным свежим токеном, повтор — уже переизданным.
    expect(tokens[0]).toBe('FRESH')
    expect(tokens[1]).toBe('REISSUED')
    // ⚠ Второй вызов обязан быть ИМЕННО force: без флага `ensureBankToken` смотрит на часы и
    // вернул бы тот же отвергнутый токен — починка была бы мёртвой.
    expect(forced).toEqual([undefined, true])
  })

  // ⚠ Мутационная проверка: передай мы в force-вызов ИСХОДНЫЙ `stored` вместо текущего токена,
  // сравнение «в базе всё ещё мой?» не совпало бы, обновления не случилось бы, и повтор ушёл бы с
  // тем же отвергнутым значением. Тест ловит это, проверяя, ЧТО именно отдали переспрашивателю.
  it('переспрашиваем ТЕКУЩИЙ токен, а не исходный из базы', async () => {
    const seen: string[] = []
    let first = true
    const { deps } = fakeDeps({
      ensureFresh: async (t, opts) => {
        seen.push(t.accessToken)
        return { ...t, accessToken: opts?.force ? 'REISSUED' : 'FRESH' }
      },
      getJson: async () => {
        if (first) {
          first = false
          throw unauthorized()
        }
        return demoAlfaResponse()
      }
    })
    await fetchBankStatement(query, deps)
    expect(seen).toEqual(['ACCESS', 'FRESH'])
  })

  it('переспрашиваем РОВНО ОДИН раз за забор — мёртвый грант не жжёт лимит банка', async () => {
    let ensured = 0
    const { deps } = fakeDeps({
      ensureFresh: async (t, opts) => {
        ensured++
        return { ...t, accessToken: opts?.force ? 'REISSUED' : 'FRESH' }
      },
      getJson: async () => {
        throw unauthorized()
      }
    })
    await expect(fetchBankStatement(query, deps)).rejects.toThrow(/401/)
    // Один обычный + один force. Третьего быть не должно: цикл «отказ → переиздание» на каждой из
    // двадцати страниц выел бы лимит банка целиком.
    expect(ensured).toBe(2)
  })

  it('ДРУГАЯ ошибка банка переспрашивания НЕ вызывает', async () => {
    let ensured = 0
    const { deps } = fakeDeps({
      ensureFresh: async (t) => {
        ensured++
        return { ...t, accessToken: 'FRESH' }
      },
      getJson: async () => {
        throw bankFetchError(Object.assign(new Error('500 Internal Server Error'), { status: 500 }))
      }
    })
    await expect(fetchBankStatement(query, deps)).rejects.toThrow(/500/)
    expect(ensured).toBe(1)
  })
})

describe('isBankUnauthorized', () => {
  it('видит статус и наверху, и в cause — живой транспорт кладёт его именно в cause', () => {
    expect(isBankUnauthorized(Object.assign(new Error('x'), { status: 401 }))).toBe(true)
    expect(isBankUnauthorized(bankFetchError(Object.assign(new Error('x'), { status: 401 })))).toBe(true)
    expect(isBankUnauthorized(bankFetchError(Object.assign(new Error('x'), { status: 403 })))).toBe(true)
  })

  it('прочие отказы — не про токен', () => {
    expect(isBankUnauthorized(bankFetchError(Object.assign(new Error('x'), { status: 500 })))).toBe(false)
    expect(isBankUnauthorized(new Error('boom'))).toBe(false)
    expect(isBankUnauthorized(null)).toBe(false)
  })

  // ⚠ По тексту не решаем: «401» встречается и в чужом сообщении, а решение здесь тратит запрос из
  // лимита банка. Мутация «искать /401/ в message» валит этот тест.
  it('текст сообщения статусом НЕ считается', () => {
    expect(isBankUnauthorized(new Error('банк ответил: код 401 в теле документа'))).toBe(false)
  })
})

// ── Пауза между переизданием пары и повтором (#615-scheme) ────────────────────────────────────
// Ключ API у Альфы ОДИН на client_id, поэтому два портала Bitrix24 на одном счёте выпускают пары
// по очереди и обесценивают токен друг друга (измерено 2026-09-10: восемь переизданий за сутки,
// чередующихся через ровно 9 операций). Пауза перед повтором разводит их во времени.
describe('пауза перед повтором после переиздания', () => {
  it('всегда в границах [1..2] с', () => {
    for (const r of [0, 0.25, 0.5, 0.999, 1]) {
      const ms = reauthPauseMs(r)
      expect(ms).toBeGreaterThanOrEqual(REAUTH_PAUSE_MIN_MS)
      expect(ms).toBeLessThanOrEqual(REAUTH_PAUSE_MAX_MS)
    }
  })

  // ⚠ Мутационная: верни функция константу — порталы остались бы синхронными, а тик крона у них
  // общий. Разброс и есть вся ценность правки, поэтому он проверяется отдельно от границ.
  it('РАЗНЫЕ значения на разных бросках — иначе порталы остаются синхронными', () => {
    expect(reauthPauseMs(0)).not.toBe(reauthPauseMs(1))
    expect(reauthPauseMs(0)).toBe(REAUTH_PAUSE_MIN_MS)
    expect(reauthPauseMs(1)).toBe(REAUTH_PAUSE_MAX_MS)
  })

  it('кривой бросок не выносит паузу за границы', () => {
    expect(reauthPauseMs(Number.NaN)).toBe(REAUTH_PAUSE_MIN_MS)
    expect(reauthPauseMs(-5)).toBe(REAUTH_PAUSE_MIN_MS)
    expect(reauthPauseMs(42)).toBe(REAUTH_PAUSE_MAX_MS)
  })

  it('на 401 ждём ПОСЛЕ переиздания и ДО повтора', async () => {
    const order: string[] = []
    let first = true
    const { deps } = fakeDeps({
      ensureFresh: async (t, opts) => {
        if (opts?.force) order.push('reissue')
        return { ...t, accessToken: opts?.force ? 'REISSUED' : 'FRESH' }
      },
      getJson: async (_url, accessToken) => {
        order.push(`get:${accessToken}`)
        if (first) {
          first = false
          throw bankFetchError(Object.assign(new Error('401 Unauthorized'), { status: 401 }))
        }
        return demoAlfaResponse()
      },
      pause: async (ms) => { order.push(`pause:${ms}`) }
    })
    await fetchBankStatement(query, deps)
    expect(order[0]).toBe('get:FRESH')
    expect(order[1]).toBe('reissue')
    expect(order[2]).toMatch(/^pause:\d+$/)
    expect(Number(order[2]!.split(':')[1])).toBeGreaterThanOrEqual(REAUTH_PAUSE_MIN_MS)
    expect(Number(order[2]!.split(':')[1])).toBeLessThanOrEqual(REAUTH_PAUSE_MAX_MS)
    expect(order[3]).toBe('get:REISSUED')
  })

  it('на успешном заборе не ждём вовсе', async () => {
    const paused: number[] = []
    const { deps } = fakeDeps({ pause: async (ms) => { paused.push(ms) } })
    await fetchBankStatement(query, deps)
    expect(paused).toEqual([])
  })

  // ⚠ Живая проводка ОБЯЗАНА давать `pause`: зависимость необязательная (иначе каждый тестовый
  // набор ждал бы по-настоящему), поэтому забытая строка в `liveDeps` не сломала бы ни одного
  // теста — правка молча перестала бы разводить порталы, а лог продолжал бы обещать паузу.
  it('liveDeps несут pause', async () => {
    const src = await readFile(new URL('../server/utils/bankFetch.ts', import.meta.url), 'utf8')
    const live = src.slice(src.indexOf('const liveDeps: BankFetchDeps = {'))
    expect(live.slice(0, live.indexOf('\n}'))).toMatch(/\n {2}pause: /)
  })
})
