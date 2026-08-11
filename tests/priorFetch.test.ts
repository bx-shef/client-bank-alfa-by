import { afterEach, describe, expect, it } from 'vitest'
import {
  fetchPriorStatement,
  isoDateOnly,
  priorApiBaseFromEnv,
  PRIOR_POLL_MAX_ATTEMPTS,
  isRetryablePollStatus,
  resolvePriorAccountId,
  type PriorFetchDeps
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
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/not ready after/)
    expect(calls.pollUrl).toHaveLength(PRIOR_POLL_MAX_ATTEMPTS) // treated as pending → retried
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
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/not ready after \d+ polls/)
    expect(calls.pollUrl).toHaveLength(PRIOR_POLL_MAX_ATTEMPTS)
    expect(calls.sleeps).toHaveLength(PRIOR_POLL_MAX_ATTEMPTS - 1) // no wait after the final attempt
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
