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
