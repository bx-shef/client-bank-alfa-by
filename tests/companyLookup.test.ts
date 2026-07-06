import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_FIELDS,
  CRM_ENTITY_TYPE_COMPANY,
  bankDetailFilter,
  extractEntityIds,
  findCompanyByAccount,
  normalizeAccount,
  requisiteFilter,
  type RestCall
} from '../server/utils/companyLookup'

describe('normalizeAccount', () => {
  it('trims and drops internal whitespace', () => {
    expect(normalizeAccount('  BY13 ALFA 3012 3456 7890  ')).toBe('BY13ALFA301234567890')
  })
  it('empty stays empty', () => {
    expect(normalizeAccount('   ')).toBe('')
  })
})

describe('extractEntityIds', () => {
  it('collects ENTITY_ID as strings, skipping empties', () => {
    const resp = { result: [{ ENTITY_ID: 27 }, { ENTITY_ID: '30' }, { ENTITY_ID: '' }, { ENTITY_ID: null }, {}] }
    expect(extractEntityIds(resp)).toEqual(['27', '30'])
  })
  it('tolerates a missing / non-array result', () => {
    expect(extractEntityIds({})).toEqual([])
    expect(extractEntityIds({ result: 'nope' } as unknown as Record<string, unknown>)).toEqual([])
  })
})

describe('filters', () => {
  it('bankDetailFilter targets one account field', () => {
    expect(bankDetailFilter('ACC1', 'RQ_ACC_NUM')).toEqual({ filter: { RQ_ACC_NUM: 'ACC1' }, select: ['ENTITY_ID'] })
  })
  it('requisiteFilter restricts to company requisites by id array', () => {
    expect(requisiteFilter(['5', '6'])).toEqual({
      filter: { ID: ['5', '6'], ENTITY_TYPE_ID: CRM_ENTITY_TYPE_COMPANY },
      select: ['ENTITY_ID']
    })
  })
})

/** Build a fake RestCall from canned responses keyed by method, recording calls. */
function fakeCall(
  responses: Partial<Record<string, (params: Record<string, unknown>) => Record<string, unknown>>>
): { call: RestCall, calls: { method: string, params: Record<string, unknown> }[] } {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const call: RestCall = async (method, params) => {
    calls.push({ method, params })
    return responses[method]?.(params) ?? { result: [] }
  }
  return { call, calls }
}

describe('findCompanyByAccount', () => {
  it('resolves company via bankdetail → requisite (RQ_ACC_NUM hit)', async () => {
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ result: [{ ENTITY_ID: '11' }] }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '42' }] })
    })
    expect(await findCompanyByAccount('ACC-1', call)).toBe('42')
    // Only the first account field is queried when it hits.
    expect(calls.map(c => c.method)).toEqual(['crm.requisite.bankdetail.list', 'crm.requisite.list'])
    expect(calls[0]!.params).toEqual(bankDetailFilter('ACC-1', 'RQ_ACC_NUM'))
    expect(calls[1]!.params).toEqual(requisiteFilter(['11']))
  })

  it('falls back to RQ_IIK when RQ_ACC_NUM finds nothing', async () => {
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': params =>
        (params.filter as Record<string, unknown>).RQ_IIK ? { result: [{ ENTITY_ID: '7' }] } : { result: [] },
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '99' }] })
    })
    expect(await findCompanyByAccount('BY13', call)).toBe('99')
    const fields = calls.filter(c => c.method === 'crm.requisite.bankdetail.list')
      .map(c => Object.keys(c.params.filter as object)[0])
    expect(fields).toEqual([...ACCOUNT_FIELDS])
  })

  it('returns the FIRST company when one account maps to several (RQ_ACC_NUM not unique)', async () => {
    // Confirmed live: the same settlement account can sit on several companies —
    // findCompanyByAccount collects every requisite id and returns the first company.
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ result: [{ ENTITY_ID: '11' }, { ENTITY_ID: '12' }] }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '42' }, { ENTITY_ID: '43' }] })
    })
    expect(await findCompanyByAccount('ACC-DUP', call)).toBe('42')
    expect(calls[1]!.params).toEqual(requisiteFilter(['11', '12']))
  })

  it('returns null when no bank detail matches (no requisite query made)', async () => {
    const { call, calls } = fakeCall({ 'crm.requisite.bankdetail.list': () => ({ result: [] }) })
    expect(await findCompanyByAccount('NOPE', call)).toBeNull()
    expect(calls.some(c => c.method === 'crm.requisite.list')).toBe(false)
  })

  it('returns null when the requisite is not a company', async () => {
    const { call } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ result: [{ ENTITY_ID: '11' }] }),
      'crm.requisite.list': () => ({ result: [] }) // ENTITY_TYPE_ID=4 filter excluded it
    })
    expect(await findCompanyByAccount('ACC-1', call)).toBeNull()
  })

  it('a REST error thrown by call propagates (not swallowed as a miss)', async () => {
    const call: RestCall = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(findCompanyByAccount('ACC-1', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })

  it('an error-SHAPED body (no result) reads as a miss — documents the RestCall contract', async () => {
    // If a binding resolves with B24's {error,...} shape instead of throwing, the
    // lookup cannot tell it from "nothing found". RestCall MUST throw on error.
    const { call } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ error: 'insufficient_scope', error_description: 'need crm' })
    })
    expect(await findCompanyByAccount('ACC-1', call)).toBeNull()
  })

  it('returns null for an empty account without calling REST', async () => {
    const { call, calls } = fakeCall({})
    expect(await findCompanyByAccount('   ', call)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('normalizes the account before querying', async () => {
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ result: [{ ENTITY_ID: '1' }] }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '2' }] })
    })
    await findCompanyByAccount(' AC C1 ', call)
    expect((calls[0]!.params.filter as Record<string, unknown>).RQ_ACC_NUM).toBe('ACC1')
  })
})
