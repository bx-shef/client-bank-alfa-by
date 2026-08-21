import { describe, expect, it, vi } from 'vitest'
import {
  alfaStatementQuery,
  bankApiConfig,
  bankFetchError,
  fetchAlfaStatementPages,
  fetchBankStatement,
  isoToAlfaDate,
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
// #561: постраничный дозабор выписки Альфы.
//
// Повод — замер, а не подозрение: за один день приходило РОВНО 100 операций, четыре дня подряд, при
// настоящих нулях в двух днях между. Капа на нашей стороне нет нигде по пути банк→разбор→crm-sync,
// значит сотня приходит от банка. `pageRowCount: '0'` документирован как «все», но это строка в PDF,
// а не измерение, и признак страницы мы никогда не читали — то есть если `0` значит «страница по
// умолчанию», мы теряли всё за сотней каждые сутки и узнать об этом не могли.
//
// ⚠ Тесты проверяют ОБА прочтения, потому что цикл обязан быть безопасен, не зная, какое верно.
// ─────────────────────────────────────────────────────────────────────────────
describe('#561: fetchAlfaStatementPages', () => {
  const row = (docId: string) => ({
    number: 'BY01', operType: 'C', amount: 10, currIso: 'BYN',
    purpose: 'p', corrName: 'n', corrNumber: 'BY99',
    docId, docNum: docId, operDate: '13.01.2026', acceptDate: '2026-01-13T14:00:00.000'
  })
  const page = (ids: string[]) => ({ page: ids.map(row), errors: [] })

  it('прочтение А («0» = все): страница 1 повторяет то же — берём один лишний запрос и молчим', async () => {
    // Банк игнорирует pageNo и отдаёт тот же набор. Без дедупа это был бы шторм дублей.
    const all = page(['a', 'b', 'c'])
    const fetchPage = vi.fn(async () => all)
    const onRecovered = vi.fn()
    const out = await fetchAlfaStatementPages('BY01', fetchPage, onRecovered)
    expect(out).toHaveLength(3)
    expect(fetchPage).toHaveBeenCalledTimes(2) // страница 0 + одна проверочная
    expect(onRecovered).not.toHaveBeenCalled() // нечего восстанавливать — не шумим
  })

  it('прочтение Б («0» = страница): забираем то, что раньше терялось, и говорим ГРОМКО', async () => {
    const pages = [page(['a', 'b']), page(['c', 'd']), page([])]
    const fetchPage = vi.fn(async (n: number) => pages[n]!)
    const onRecovered = vi.fn()
    const out = await fetchAlfaStatementPages('BY01', fetchPage, onRecovered)
    expect(out.map(i => i.docId)).toEqual(['a', 'b', 'c', 'd'])
    // ⚠ Молчаливое восстановление было бы хуже потери: оно скрыло бы, как долго это длилось.
    expect(onRecovered).toHaveBeenCalledWith({ pages: 3, recovered: 2 })
  })

  it('пустая первая страница — ровно один запрос, никакого дозабора', async () => {
    const fetchPage = vi.fn(async () => page([]))
    const out = await fetchAlfaStatementPages('BY01', fetchPage)
    expect(out).toEqual([])
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('частичное пересечение страниц не задваивает и не теряет', async () => {
    // Сдвиг окна между запросами — банк вернул хвост предыдущей страницы заново.
    const pages = [page(['a', 'b']), page(['b', 'c']), page(['c'])]
    const fetchPage = vi.fn(async (n: number) => pages[n]!)
    const out = await fetchAlfaStatementPages('BY01', fetchPage)
    expect(out.map(i => i.docId)).toEqual(['a', 'b', 'c'])
  })

  it('ошибка банка на ЛЮБОЙ странице роняет забор — errored-ответ это не «нет операций»', async () => {
    const fetchPage = vi.fn(async (n: number) =>
      n === 0 ? page(['a']) : { page: [], errors: [{ message: 'token expired' }] })
    await expect(fetchAlfaStatementPages('BY01', fetchPage)).rejects.toThrow(/token expired/)
  })

  it('бесконечная выдача упирается в потолок страниц, а не крутится вечно', async () => {
    let n = 0
    const fetchPage = vi.fn(async () => page([`x${n++}`])) // каждый раз НОВЫЙ id
    const out = await fetchAlfaStatementPages('BY01', fetchPage)
    expect(fetchPage).toHaveBeenCalledTimes(MAX_ALFA_STATEMENT_PAGES)
    expect(out).toHaveLength(MAX_ALFA_STATEMENT_PAGES)
  })

  it('первый запрос идентичен прежнему — прод не меняется', () => {
    // ⚠ Регресс-якорь: pageNo=0 обязан давать ту же строку, что и до правки.
    expect(alfaStatementQuery('BY01', '2026-01-13', '2026-01-13').toString())
      .toBe(alfaStatementQuery('BY01', '2026-01-13', '2026-01-13', 0).toString())
    expect(alfaStatementQuery('BY01', '2026-01-13', '2026-01-13').toString()).toContain('pageNo=0')
    expect(alfaStatementQuery('BY01', '2026-01-13', '2026-01-13').toString()).toContain('pageRowCount=0')
  })
})
