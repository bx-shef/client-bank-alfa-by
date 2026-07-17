import { describe, expect, it, vi } from 'vitest'
import {
  alfaStatementQuery,
  bankApiConfig,
  bankFetchError,
  fetchBankStatement,
  isoToAlfaDate,
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

  it('Prior online fetch is not wired yet → throws A5b (never a silent empty)', async () => {
    const priorQ: BankFetchQuery = { ...query, provider: 'prior-by' }
    const priorTok: BankToken = { ...tok, provider: 'prior-by' }
    const { deps } = fakeDeps({ stored: priorTok, apiConfig: () => ({ base: 'https://prior', statementPath: '/accounts' }) })
    await expect(fetchBankStatement(priorQ, deps)).rejects.toThrow(/A5b/)
  })
})
