import { describe, it, expect } from 'vitest'
import { crmSideAccounts, handleBankMatrix, type BankMatrixDeps } from '../server/utils/bankMatrix'
import type { MatrixRow } from '../app/utils/bankAccountMatrix'

function deps(over: Partial<BankMatrixDeps> = {}): BankMatrixDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '1', isAdmin: true }),
    myCompanies: async () => [{ companyId: '7', accounts: ['BY11ALFA0001'] }],
    bankSide: async () => [{ provider: 'alfa-by', accounts: [{ number: 'BY11ALFA0001', currency: 'BYN' }] }],
    connected: async () => ['BY11ALFA0001'],
    ...over
  }
}

const input = { accessToken: 'T', domain: 'p.bitrix24.by' }

describe('crmSideAccounts', () => {
  it('flattens companies into rows carrying their owner', () => {
    expect(crmSideAccounts([
      { companyId: '7', accounts: ['A', 'B'] },
      { companyId: '9', accounts: ['C'] }
    ])).toEqual([
      { companyId: '7', number: 'A' },
      { companyId: '7', number: 'B' },
      { companyId: '9', number: 'C' }
    ])
  })

  it('contributes nothing for a company with no account — that is the readiness screen`s row', () => {
    expect(crmSideAccounts([{ companyId: '7', accounts: [] }])).toEqual([])
  })
})

describe('handleBankMatrix gate', () => {
  it('400 without frame auth', async () => {
    expect((await handleBankMatrix(deps(), { accessToken: '', domain: 'p' })).status).toBe(400)
    expect((await handleBankMatrix(deps(), { accessToken: 'T', domain: '  ' })).status).toBe(400)
  })

  it('409 when the portal is not installed', async () => {
    const res = await handleBankMatrix(deps({ memberIdByDomain: async () => null }), input)
    expect(res.status).toBe(409)
  })

  it('403 when the frame token is not valid for THIS domain (spoofing block)', async () => {
    const res = await handleBankMatrix(deps({ validateFrame: async () => {
      throw new Error('nope')
    } }), input)
    expect(res.status).toBe(403)
  })

  it('403 for a non-admin — bank identity is portal-wide', async () => {
    const res = await handleBankMatrix(deps({ validateFrame: async () => ({ userId: '2', isAdmin: false }) }), input)
    expect(res.status).toBe(403)
  })

  it('does not touch CRM or the bank before the gate passes', async () => {
    let touched = false
    await handleBankMatrix(deps({
      validateFrame: async () => ({ userId: '2', isAdmin: false }),
      myCompanies: async () => {
        touched = true
        return []
      },
      bankSide: async () => {
        touched = true
        return []
      }
    }), input)
    expect(touched).toBe(false)
  })
})

describe('handleBankMatrix result', () => {
  it('reports a clean portal as one matched row', async () => {
    const res = await handleBankMatrix(deps(), input)
    expect(res.status).toBe(200)
    const rows = res.body.rows as MatrixRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('matched')
    expect(rows[0]?.connected).toBe(true)
  })

  it('surfaces the whitespace trap as `looks-same`, not as a match', async () => {
    const res = await handleBankMatrix(deps({
      myCompanies: async () => [{ companyId: '7', accounts: ['BY11 ALFA 0001'] }]
    }), input)
    const rows = res.body.rows as MatrixRow[]
    expect(rows[0]?.state).toBe('looks-same')
  })

  it('merges accounts from every connected bank into one matrix', async () => {
    const res = await handleBankMatrix(deps({
      myCompanies: async () => [{ companyId: '7', accounts: ['BY11ALFA0001', 'BY11PJCB0002'] }],
      bankSide: async () => [
        { provider: 'alfa-by', accounts: [{ number: 'BY11ALFA0001' }] },
        { provider: 'prior-by', accounts: [{ number: 'BY11PJCB0002' }] }
      ]
    }), input)
    const rows = res.body.rows as MatrixRow[]
    expect(rows.every(r => r.state === 'matched')).toBe(true)
    expect(rows).toHaveLength(2)
  })

  it('reports a per-provider bank error SEPARATELY from the rows', async () => {
    const res = await handleBankMatrix(deps({
      bankSide: async () => [{ provider: 'alfa-by', accounts: [], error: 'банк не ответил (503)' }]
    }), input)
    expect(res.status).toBe(200)
    expect(res.body.providers).toEqual([{ provider: 'alfa-by', count: 0, error: 'банк не ответил (503)' }])
    // The CRM row must NOT be rendered as `matched` just because the bank half is missing.
    const rows = res.body.rows as MatrixRow[]
    expect(rows[0]?.state).not.toBe('matched')
  })

  // ⚠ ХВОСТ #539. This assertion used to read `toBe('crm-only')` — the test PINNED the defect. A
  // provider that errors contributes no accounts, so every CRM account was labelled «банк его не
  // отдаёт» with an instruction to connect the bank, while the alert directly above said the
  // bank's list was unknown. A healthy portal was sent to fix healthy requisites for the few
  // seconds a token renewal holds the lock.
  it('a silent bank yields `unchecked`, never the confident «банк его не отдаёт»', async () => {
    const res = await handleBankMatrix(deps({
      bankSide: async () => [{
        provider: 'alfa-by',
        accounts: [],
        error: 'подключение сейчас обновляется — повторите через несколько секунд'
      }]
    }), input)
    const rows = res.body.rows as MatrixRow[]
    expect(rows[0]?.state).toBe('unchecked')
  })

  it('an answering bank still yields `crm-only` — the honest «банк о нём не знает»', async () => {
    // Mutation guard: wire the flag unconditionally and this real state disappears entirely.
    const res = await handleBankMatrix(deps({
      bankSide: async () => [{ provider: 'alfa-by', accounts: [{ number: 'BY11ALFA7777' }] }]
    }), input)
    const rows = res.body.rows as MatrixRow[]
    expect(rows.find(r => r.crm)?.state).toBe('crm-only')
  })

  it('ONE silent bank clouds the unmatched rows even when the other answered', async () => {
    // We cannot tell which bank a CRM account belongs to — that is the question being asked. So a
    // single unanswered provider is enough to turn «нет у банка» into «не спрашивали».
    const res = await handleBankMatrix(deps({
      myCompanies: async () => [{ companyId: '7', accounts: ['BY11ALFA0001', 'BY11PJCB0002'] }],
      bankSide: async () => [
        { provider: 'alfa-by', accounts: [{ number: 'BY11ALFA0001' }] },
        { provider: 'prior-by', accounts: [], error: 'банк не ответил (503)' }
      ]
    }), input)
    const rows = res.body.rows as MatrixRow[]
    expect(rows.map(r => r.state).sort()).toEqual(['matched', 'unchecked'])
  })

  it('an empty-but-successful answer is NOT «incomplete» — it is a real, negative answer', async () => {
    // ⚠ `accounts: []` without an `error` means the bank replied and covers nothing. Treating that
    // as unknown would hide the genuinely broken portal this screen exists for.
    const res = await handleBankMatrix(deps({
      bankSide: async () => [{ provider: 'alfa-by', accounts: [] }]
    }), input)
    const rows = res.body.rows as MatrixRow[]
    expect(rows[0]?.state).toBe('crm-only')
  })

  it('an empty error string does not count as a failure', async () => {
    // `error: ''` is what a sloppy transport produces; `Boolean(p.error)` must read it as «no error»
    // rather than clouding every row on a healthy portal.
    const res = await handleBankMatrix(deps({
      bankSide: async () => [{ provider: 'alfa-by', accounts: [], error: '' }]
    }), input)
    const rows = res.body.rows as MatrixRow[]
    expect(rows[0]?.state).toBe('crm-only')
  })

  it('502 when CRM cannot be read — a blank CRM half would be actively misleading', async () => {
    const res = await handleBankMatrix(deps({ myCompanies: async () => {
      throw new Error('rest down')
    } }), input)
    expect(res.status).toBe(502)
    expect(res.body.rows).toBeUndefined()
  })

  it('marks an account the bank reports but CRM lacks as `bank-only`, first in the list', async () => {
    const res = await handleBankMatrix(deps({
      myCompanies: async () => [{ companyId: '7', accounts: ['BY11ALFA0001'] }],
      bankSide: async () => [{
        provider: 'alfa-by',
        accounts: [{ number: 'BY11ALFA0001' }, { number: 'BY11ALFA9999' }]
      }]
    }), input)
    const rows = res.body.rows as MatrixRow[]
    expect(rows[0]?.state).toBe('bank-only')
    expect(rows[0]?.bank?.number).toBe('BY11ALFA9999')
  })

  it('passes the connected keys through so the UI can tell connected from merely known', async () => {
    const res = await handleBankMatrix(deps({ connected: async () => [] }), input)
    const rows = res.body.rows as MatrixRow[]
    expect(rows[0]?.connected).toBe(false)
  })
})
