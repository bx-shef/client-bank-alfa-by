import { describe, expect, it, vi } from 'vitest'
import { findCandidateByField, findCandidateById, firstItem, itemByFieldParams, itemByIdParams } from '../server/utils/itemByIdLookup'

// By-id target resolver (#109). Field names confirmed live; the id is untrusted so
// IDOR is enforced by filtering on companyId in the query.

const resp = (items: unknown[]) => ({ result: { items } })
const item = (over: Record<string, unknown> = {}) => ({
  id: 33, companyId: 93, stageId: 'C5:NEW', opportunity: 1200, currencyId: 'BYN', ...over
})

describe('itemByIdParams', () => {
  it('filters by id AND companyId (IDOR) and omits parentId2 for a DEAL (self-reference — Bitrix rejects it live)', () => {
    expect(itemByIdParams(2, '33', '93')).toEqual({
      entityTypeId: 2,
      filter: { id: '33', companyId: '93' },
      select: ['id', 'companyId', 'stageId', 'opportunity', 'currencyId']
    })
  })

  it('selects parentId2 for an INVOICE (31) — its linked deal (#229), a valid different-type parent', () => {
    expect(itemByIdParams(31, '33', '93').select).toEqual(['id', 'companyId', 'stageId', 'opportunity', 'currencyId', 'parentId2'])
  })
})

describe('itemByFieldParams', () => {
  it('filters by the configured FIELD AND companyId (IDOR) and omits parentId2 for a DEAL (self-reference)', () => {
    expect(itemByFieldParams(2, 'UF_CRM_PAY_NO', '6001', '93')).toEqual({
      entityTypeId: 2,
      filter: { UF_CRM_PAY_NO: '6001', companyId: '93' },
      select: ['id', 'companyId', 'stageId', 'opportunity', 'currencyId']
    })
  })

  it('selects parentId2 for a smart process (custom entityTypeId) — a valid different-type parent', () => {
    expect(itemByFieldParams(1032, 'UF_CRM_5_PAY', '6001', '93').select).toContain('parentId2')
  })
})

describe('findCandidateByField', () => {
  it('maps a found deal to a candidate and queries by the configured field + companyId', async () => {
    const call = vi.fn(async () => resp([item({ id: 77, opportunity: 0, currencyId: 'BYN', stageId: 'C5:NEW' })]))
    expect(await findCandidateByField('deal', 2, 'UF_CRM_PAY_NO', '6001', { companyId: '93' }, call))
      .toEqual({ kind: 'deal', id: '77', amount: 0, currency: 'BYN' })
    expect(call.mock.calls[0]![0]).toBe('crm.item.list')
    expect(call.mock.calls[0]![1]).toMatchObject({ entityTypeId: 2, filter: { UF_CRM_PAY_NO: '6001', companyId: '93' } })
  })

  it('returns null for a malformed field name (fail-safe — no filter-key injection)', async () => {
    const call = vi.fn(async () => resp([item()]))
    // A leading operator / space / punctuation must NOT reach the filter key.
    expect(await findCandidateByField('deal', 2, '>UF_X', '6001', { companyId: '93' }, call)).toBeNull()
    expect(await findCandidateByField('deal', 2, 'UF X', '6001', { companyId: '93' }, call)).toBeNull()
    expect(await findCandidateByField('deal', 2, '', '6001', { companyId: '93' }, call)).toBeNull()
    expect(call).not.toHaveBeenCalled() // never queried with a bad key
  })

  it('returns null for an empty value or empty company (IDOR scope required)', async () => {
    const call = vi.fn(async () => resp([item()]))
    expect(await findCandidateByField('deal', 2, 'UF_X', '  ', { companyId: '93' }, call)).toBeNull()
    expect(await findCandidateByField('deal', 2, 'UF_X', '6001', { companyId: '' }, call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it('returns null for a negative-stage match (same drop as by-id)', async () => {
    const call = vi.fn(async () => resp([item({ stageId: 'C5:LOSE' })]))
    const isNegativeStage = (s: string) => s === 'C5:LOSE'
    expect(await findCandidateByField('deal', 2, 'UF_X', '6001', { companyId: '93', isNegativeStage }, call)).toBeNull()
  })

  it('returns null when no item matches the field (empty list)', async () => {
    const call = vi.fn(async () => resp([]))
    expect(await findCandidateByField('deal', 2, 'UF_X', '6001', { companyId: '93' }, call)).toBeNull()
  })

  it('propagates a REST error thrown by call (job must retry)', async () => {
    const call = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(findCandidateByField('deal', 2, 'UF_X', '6001', { companyId: '93' }, call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})

describe('firstItem', () => {
  it('returns result.items[0], tolerating a missing/!array shape', () => {
    expect(firstItem(resp([item({ id: 7 })]))?.id).toBe(7)
    expect(firstItem(resp([]))).toBeUndefined()
    expect(firstItem({})).toBeUndefined()
    expect(firstItem({ result: { items: 'x' } })).toBeUndefined()
  })
})

describe('findCandidateById', () => {
  it('maps a found deal to an AllocationCandidate', async () => {
    const call = vi.fn(async () => resp([item({ id: 33, opportunity: 1200, currencyId: 'BYN' })]))
    expect(await findCandidateById('deal', 2, '33', { companyId: '93' }, call))
      .toEqual({ kind: 'deal', id: '33', amount: 1200, currency: 'BYN' })
    expect(call.mock.calls[0]![0]).toBe('crm.item.list')
    expect(call.mock.calls[0]![1]).toMatchObject({ entityTypeId: 2, filter: { id: '33', companyId: '93' } })
  })

  it('populates dealId from parentId2 for an invoice-id target (#229)', async () => {
    const call = vi.fn(async () => resp([item({ id: 9, opportunity: 1200, currencyId: 'BYN', parentId2: 15, stageId: 'DT31_11:N' })]))
    expect(await findCandidateById('invoice', 31, '9', { companyId: '7' }, call))
      .toEqual({ kind: 'invoice', id: '9', amount: 1200, currency: 'BYN', dealId: '15' })
  })

  it('does NOT set dealId for a non-invoice kind (a deal is not its own parent)', async () => {
    const call = vi.fn(async () => resp([item({ id: 33, parentId2: 99 })]))
    const c = await findCandidateById('deal', 2, '33', { companyId: '93' }, call)
    expect(c && 'dealId' in c).toBe(false)
  })

  it('returns null when the id belongs to another company (empty items — IDOR)', async () => {
    const call = vi.fn(async () => resp([])) // companyId filter excluded it
    expect(await findCandidateById('invoice', 31, '33', { companyId: '999' }, call)).toBeNull()
  })

  it('returns null for a negative-stage entity (e.g. C5:LOSE)', async () => {
    const call = vi.fn(async () => resp([item({ stageId: 'C5:LOSE' })]))
    const isNegativeStage = (s: string) => s === 'C5:LOSE'
    expect(await findCandidateById('deal', 2, '33', { companyId: '93', isNegativeStage }, call)).toBeNull()
  })

  it('keeps the entity when no stage predicate is given', async () => {
    const call = vi.fn(async () => resp([item({ stageId: 'C5:LOSE' })]))
    expect(await findCandidateById('deal', 2, '33', { companyId: '93' }, call)).not.toBeNull()
  })

  it('normalizes a non-finite amount to 0 for a trigger kind (deal/smart-process ignore amount)', async () => {
    const call = vi.fn(async () => resp([item({ opportunity: undefined, currencyId: 'BYN' })]))
    expect((await findCandidateById('smart-process', 1032, '1', { companyId: '93' }, call))?.amount).toBe(0)
  })

  it('threads entityTypeId onto a smart-process candidate (needed as OWNER_TYPE_ID to fire its trigger, #79)', async () => {
    const call = vi.fn(async () => resp([item({ id: 1, opportunity: 0, currencyId: 'BYN' })]))
    // Without this, buildTriggerExecution → null → the smart-process trigger could never fire.
    expect(await findCandidateById('smart-process', 1032, '1', { companyId: '93' }, call))
      .toEqual({ kind: 'smart-process', id: '1', amount: 0, currency: 'BYN', entityTypeId: 1032 })
  })

  it('does NOT set entityTypeId for a deal (fixed OWNER_TYPE_ID=2) or amount kinds (#79)', async () => {
    const call = vi.fn(async () => resp([item({ id: 33, opportunity: 5, currencyId: 'BYN' })]))
    expect((await findCandidateById('deal', 2, '33', { companyId: '93' }, call).then(c => c && 'entityTypeId' in c))).toBe(false)
    expect((await findCandidateById('invoice', 31, '33', { companyId: '93' }, call).then(c => c && 'entityTypeId' in c))).toBe(false)
  })

  it('returns null on a non-finite amount for an amount-gated kind (fail-closed, like invoiceLookup)', async () => {
    const call = vi.fn(async () => resp([item({ opportunity: 'n/a' })]))
    expect(await findCandidateById('invoice', 31, '33', { companyId: '93' }, call)).toBeNull()
    expect(await findCandidateById('deal-payment', 31, '33', { companyId: '93' }, call)).toBeNull()
  })

  it('parses a string opportunity (the real crm.item.list shape)', async () => {
    const call = vi.fn(async () => resp([item({ opportunity: '250.0000' })]))
    expect((await findCandidateById('deal', 2, '33', { companyId: '93' }, call))?.amount).toBe(250)
  })

  it('returns null when the found item has an empty id', async () => {
    const call = vi.fn(async () => resp([item({ id: undefined })]))
    expect(await findCandidateById('deal', 2, '33', { companyId: '93' }, call)).toBeNull()
  })

  it('feeds an empty string to the stage predicate when stageId is missing', async () => {
    const seen: string[] = []
    const call = vi.fn(async () => resp([item({ stageId: undefined })]))
    await findCandidateById('deal', 2, '33', { companyId: '93', isNegativeStage: (s) => {
      seen.push(s)
      return false
    } }, call)
    expect(seen).toEqual([''])
  })

  it('trims the id inside the REST filter, not just for the guard', async () => {
    const call = vi.fn(async () => resp([item()]))
    await findCandidateById('deal', 2, '  33  ', { companyId: '93' }, call)
    expect(call.mock.calls[0]![1]).toMatchObject({ filter: { id: '33', companyId: '93' } })
  })

  it('trims the id and returns null for a blank id / blank company without REST', async () => {
    const call = vi.fn(async () => resp([item()]))
    expect(await findCandidateById('deal', 2, '  ', { companyId: '93' }, call)).toBeNull()
    expect(await findCandidateById('deal', 2, '33', { companyId: '  ' }, call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it('propagates a REST error thrown by call', async () => {
    const call = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(findCandidateById('deal', 2, '33', { companyId: '93' }, call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
