import { describe, expect, it, vi } from 'vitest'
import type { RestCall } from '../server/utils/companyLookup'
import {
  buildPortalNegativeStagePredicate,
  extractCategoryIds,
  loadCategoryIds,
  loadEntityNegativeStages
} from '../server/utils/negativeStages'

/** A fake RestCall that dispatches by method, so the pure loaders can be exercised
 *  without the network. `statuses` maps a crm.status ENTITY_ID → its status rows. */
function fakeCall(opts: {
  categories?: Record<number, Array<{ id: number | string }>>
  statuses?: Record<string, Array<{ STATUS_ID: string, SEMANTICS?: string, EXTRA?: { SEMANTICS?: string } }>>
}): { call: RestCall, calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = []
  const call: RestCall = async (method, params) => {
    calls.push([method, params])
    if (method === 'crm.category.list') {
      const etid = params.entityTypeId as number
      return { result: { categories: opts.categories?.[etid] ?? [] } }
    }
    if (method === 'crm.status.list') {
      const entityId = String((params.filter as Record<string, unknown>).ENTITY_ID)
      return { result: opts.statuses?.[entityId] ?? [] }
    }
    return {}
  }
  return { call, calls }
}

describe('extractCategoryIds', () => {
  it('pulls result.categories[].id as strings (incl. the default funnel id 0)', () => {
    const resp = { result: { categories: [{ id: 0 }, { id: 5 }, { id: '11' }] } }
    expect(extractCategoryIds(resp)).toEqual(['0', '5', '11'])
  })
  it('tolerates a missing/non-array result and rows without an id', () => {
    expect(extractCategoryIds({})).toEqual([])
    expect(extractCategoryIds({ result: {} })).toEqual([])
    expect(extractCategoryIds({ result: { categories: [{}, { id: null }, { id: 3 }] } })).toEqual(['3'])
  })
})

describe('loadCategoryIds', () => {
  it('lists a category ids via crm.category.list', async () => {
    const { call, calls } = fakeCall({ categories: { 2: [{ id: 0 }, { id: 7 }] } })
    expect(await loadCategoryIds(2, call)).toEqual(['0', '7'])
    expect(calls).toEqual([['crm.category.list', { entityTypeId: 2 }]])
  })
})

describe('loadEntityNegativeStages', () => {
  it('unions the negative stages across every category', async () => {
    const { call } = fakeCall({
      categories: { 31: [{ id: 11 }, { id: 12 }] },
      statuses: {
        SMART_INVOICE_STAGE_11: [{ STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' }, { STATUS_ID: 'DT31_11:P' }],
        SMART_INVOICE_STAGE_12: [{ STATUS_ID: 'DT31_12:D', EXTRA: { SEMANTICS: 'failure' } }]
      }
    })
    const { negative, categories } = await loadEntityNegativeStages(31, id => `SMART_INVOICE_STAGE_${id}`, call)
    expect(categories).toBe(2)
    expect([...negative].sort()).toEqual(['DT31_11:D', 'DT31_12:D'])
  })

  it('returns an empty set + zero categories when the entity has no funnels', async () => {
    const { call } = fakeCall({ categories: { 31: [] } })
    const { negative, categories } = await loadEntityNegativeStages(31, id => `X_${id}`, call)
    expect(categories).toBe(0)
    expect(negative.size).toBe(0)
  })
})

describe('buildPortalNegativeStagePredicate', () => {
  it('builds a union predicate over invoices AND deals (namespaces do not collide)', async () => {
    const { call } = fakeCall({
      categories: { 31: [{ id: 11 }], 2: [{ id: 0 }, { id: 5 }] },
      statuses: {
        SMART_INVOICE_STAGE_11: [{ STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' }],
        DEAL_STAGE: [{ STATUS_ID: 'LOSE', SEMANTICS: 'F' }, { STATUS_ID: 'WON' }],
        DEAL_STAGE_5: [{ STATUS_ID: 'C5:LOSE', SEMANTICS: 'F' }]
      }
    })
    const { predicate, diagnostics } = await buildPortalNegativeStagePredicate(call)
    // negative stages of both entity types are recognized by ONE predicate
    expect(predicate('DT31_11:D')).toBe(true)
    expect(predicate('LOSE')).toBe(true)
    expect(predicate('C5:LOSE')).toBe(true)
    // positive/other stages are kept; a blank stage is never negative
    expect(predicate('DT31_11:P')).toBe(false)
    expect(predicate('WON')).toBe(false)
    expect(predicate('')).toBe(false)
    expect(diagnostics).toEqual({
      invoice: { categories: 1, negativeStages: 1 },
      deal: { categories: 2, negativeStages: 2 }
    })
  })

  it('surfaces zero deal negatives in diagnostics (fail-open signal for the caller)', async () => {
    const { call } = fakeCall({
      categories: { 31: [{ id: 11 }], 2: [{ id: 0 }] },
      statuses: {
        SMART_INVOICE_STAGE_11: [{ STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' }],
        DEAL_STAGE: [{ STATUS_ID: 'WON' }] // no negative stage present / query trimmed
      }
    })
    const { diagnostics } = await buildPortalNegativeStagePredicate(call)
    expect(diagnostics.deal).toEqual({ categories: 1, negativeStages: 0 })
  })

  it('propagates a transport error', async () => {
    const call: RestCall = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(buildPortalNegativeStagePredicate(call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
