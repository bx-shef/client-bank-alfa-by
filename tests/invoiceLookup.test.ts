import { describe, expect, it, vi } from 'vitest'
import {
  SMART_INVOICE_ENTITY_TYPE_ID,
  extractInvoiceItems,
  findInvoicesByNumber,
  invoiceListParams
} from '../server/utils/invoiceLookup'

// Smart Invoice lookup (#109). Field names confirmed live (crm.item.fields
// entityTypeId=31). Fake-query tests: assert the REST params and the mapping to
// AllocationCandidate, incl. the negative-stage filter and defensive skips.

const resp = (items: unknown[]) => ({ result: { items } })
const inv = (over: Record<string, unknown> = {}) => ({
  id: 1, accountNumber: 'СЧ-2001', companyId: 5, stageId: 'DT31_11:N', opportunity: 250, currencyId: 'BYN', ...over
})

describe('invoiceListParams', () => {
  it('filters by accountNumber AND companyId on entityTypeId 31', () => {
    expect(invoiceListParams('СЧ-2001', '5')).toMatchObject({
      entityTypeId: SMART_INVOICE_ENTITY_TYPE_ID,
      filter: { accountNumber: 'СЧ-2001', companyId: '5' }
    })
  })
})

describe('extractInvoiceItems', () => {
  it('pulls result.items and tolerates a missing/!array shape', () => {
    expect(extractInvoiceItems(resp([inv()]))).toHaveLength(1)
    expect(extractInvoiceItems({})).toEqual([])
    expect(extractInvoiceItems({ result: {} })).toEqual([])
    expect(extractInvoiceItems({ result: { items: 'x' } })).toEqual([])
  })
})

describe('findInvoicesByNumber', () => {
  it('maps opportunity→amount, currencyId→currency, id→string', async () => {
    const call = vi.fn(async () => resp([inv({ id: 7, opportunity: 250, currencyId: 'BYN' })]))
    expect(await findInvoicesByNumber('СЧ-2001', { companyId: '5' }, call))
      .toEqual([{ kind: 'invoice', id: '7', amount: 250, currency: 'BYN' }])
    expect(call.mock.calls[0]![0]).toBe('crm.item.list')
    expect(call.mock.calls[0]![1]).toMatchObject({ filter: { accountNumber: 'СЧ-2001', companyId: '5' } })
  })

  it('excludes negative-stage invoices (SEMANTICS F)', async () => {
    const call = vi.fn(async () => resp([
      inv({ id: 1, stageId: 'DT31_11:D' }), // Не оплачен → negative
      inv({ id: 2, stageId: 'DT31_11:N' })
    ]))
    const isNegativeStage = (s: string) => s === 'DT31_11:D'
    const res = await findInvoicesByNumber('СЧ-2001', { companyId: '5', isNegativeStage }, call)
    expect(res.map(c => c.id)).toEqual(['2'])
  })

  it('keeps every stage when no predicate is given', async () => {
    const call = vi.fn(async () => resp([inv({ id: 1, stageId: 'DT31_11:D' })]))
    expect(await findInvoicesByNumber('СЧ-2001', { companyId: '5' }, call)).toHaveLength(1)
  })

  it('skips rows with a non-finite amount or empty id', async () => {
    const call = vi.fn(async () => resp([
      inv({ id: 1, opportunity: 'x' }), // amount NaN
      inv({ id: '', opportunity: 100 }), // empty id
      inv({ id: 3, opportunity: 100 })
    ]))
    expect((await findInvoicesByNumber('СЧ-2001', { companyId: '5' }, call)).map(c => c.id)).toEqual(['3'])
  })

  it('returns [] for a blank accountNumber without calling REST', async () => {
    const call = vi.fn(async () => resp([inv()]))
    expect(await findInvoicesByNumber('  ', { companyId: '5' }, call)).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('returns several candidates when one number has several invoices', async () => {
    const call = vi.fn(async () => resp([inv({ id: 1 }), inv({ id: 2 })]))
    expect(await findInvoicesByNumber('СЧ-2001', { companyId: '5' }, call)).toHaveLength(2)
  })
})
