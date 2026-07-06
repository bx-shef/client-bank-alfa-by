import { describe, expect, it, vi } from 'vitest'
import {
  extractNegativeStageIds,
  invoiceStageEntityId,
  loadInvoiceNegativeStage,
  loadNegativeStages,
  makeIsNegativeStage
} from '../server/utils/stageLoader'

// Stage loader (#109). Field names confirmed live (crm.status.list on a Smart
// Invoice: STATUS_ID + SEMANTICS; «Не оплачен» DT31_11:D has SEMANTICS='F').

const resp = (rows: unknown[]) => ({ result: rows })
const invoiceRows = [
  { STATUS_ID: 'DT31_11:N', SEMANTICS: null }, // Новый
  { STATUS_ID: 'DT31_11:S', SEMANTICS: null }, // Отправлен
  { STATUS_ID: 'DT31_11:P', SEMANTICS: 'S' }, // Оплачен (success)
  { STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' } // Не оплачен (negative)
]

describe('invoiceStageEntityId', () => {
  it('builds SMART_INVOICE_STAGE_<categoryId>', () => {
    expect(invoiceStageEntityId(11)).toBe('SMART_INVOICE_STAGE_11')
    expect(invoiceStageEntityId('7')).toBe('SMART_INVOICE_STAGE_7')
  })
})

describe('extractNegativeStageIds', () => {
  it('keeps only SEMANTICS=F ids, coerced to string', () => {
    expect(extractNegativeStageIds(resp(invoiceRows))).toEqual(new Set(['DT31_11:D']))
  })
  it('returns an empty set for a missing / non-array result', () => {
    expect(extractNegativeStageIds({})).toEqual(new Set())
    expect(extractNegativeStageIds({ result: 'x' })).toEqual(new Set())
  })
  it('skips rows without a STATUS_ID', () => {
    expect(extractNegativeStageIds(resp([{ SEMANTICS: 'F' }, { STATUS_ID: '', SEMANTICS: 'F' }]))).toEqual(new Set())
  })
})

describe('loadNegativeStages', () => {
  it('queries crm.status.list by ENTITY_ID and returns the negative set', async () => {
    const call = vi.fn(async () => resp(invoiceRows))
    expect(await loadNegativeStages('SMART_INVOICE_STAGE_11', call)).toEqual(new Set(['DT31_11:D']))
    expect(call.mock.calls[0]![0]).toBe('crm.status.list')
    expect(call.mock.calls[0]![1]).toMatchObject({ filter: { ENTITY_ID: 'SMART_INVOICE_STAGE_11' } })
  })
  it('propagates a REST error thrown by call', async () => {
    const call = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(loadNegativeStages('X', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})

describe('makeIsNegativeStage', () => {
  it('is true only for ids in the set', () => {
    const pred = makeIsNegativeStage(new Set(['DT31_11:D']))
    expect(pred('DT31_11:D')).toBe(true)
    expect(pred('DT31_11:P')).toBe(false)
  })
  it('treats an empty set / blank stage as not-negative', () => {
    expect(makeIsNegativeStage(new Set())('DT31_11:D')).toBe(false)
    expect(makeIsNegativeStage(new Set(['']))('')).toBe(false)
  })
})

describe('loadInvoiceNegativeStage', () => {
  it('loads the predicate for a Smart Invoice category', async () => {
    const call = vi.fn(async () => resp(invoiceRows))
    const isNeg = await loadInvoiceNegativeStage(11, call)
    expect(isNeg('DT31_11:D')).toBe(true)
    expect(isNeg('DT31_11:P')).toBe(false)
    expect(call.mock.calls[0]![1]).toMatchObject({ filter: { ENTITY_ID: 'SMART_INVOICE_STAGE_11' } })
  })
})
