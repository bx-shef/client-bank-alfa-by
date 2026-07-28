import { describe, expect, it } from 'vitest'
import {
  fetchPriorStatement,
  isoDateOnly,
  priorApiBaseFromEnv,
  PRIOR_POLL_MAX_ATTEMPTS,
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

function fakeDeps(over: Partial<PriorFetchDeps> & { pollSequence?: unknown[] } = {}) {
  const calls = { postUrl: [] as string[], pollUrl: [] as string[], sleeps: [] as number[], ensured: 0 }
  const pollSequence = over.pollSequence ? [...over.pollSequence] : [readyResponse()]
  const deps: PriorFetchDeps = {
    ensureFresh: async (t) => {
      calls.ensured++
      return { ...t, accessToken: 'FRESH' }
    },
    apiBase: () => 'https://prior:9544', // OB origin (the OB prefix is added by the path builder)
    postJson: async (url) => {
      calls.postUrl.push(url)
      return { data: { transaction: { transactionListId: 'RES-9' } } }
    },
    pollJson: async (url) => {
      calls.pollUrl.push(url)
      return pollSequence.length > 1 ? pollSequence.shift() : pollSequence[0]
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
    // create posts to /accounts/{account}/transactions, poll GETs /accounts/{account}/transactions/{id}
    expect(calls.postUrl[0]).toContain('/open-banking/v1.0/accounts/ACC-1/transactions')
    expect(calls.pollUrl[0]).toContain('/open-banking/v1.0/accounts/ACC-1/transactions/RES-9')
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

  it('throws after exhausting the poll budget (never ready)', async () => {
    const { deps, calls } = fakeDeps({ pollSequence: [pendingResponse] })
    await expect(fetchPriorStatement(query, tok, deps)).rejects.toThrow(/not ready after \d+ polls/)
    expect(calls.pollUrl).toHaveLength(PRIOR_POLL_MAX_ATTEMPTS)
    expect(calls.sleeps).toHaveLength(PRIOR_POLL_MAX_ATTEMPTS - 1) // no wait after the final attempt
  })
})
