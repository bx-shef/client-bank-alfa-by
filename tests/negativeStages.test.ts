import { describe, expect, it, vi } from 'vitest'
import type { RestCall } from '../server/utils/companyLookup'
import {
  buildPortalNegativeStagePredicate,
  extractCategoryIds,
  failOpenEntities,
  loadCategoryIds,
  loadEntityNegativeStages,
  stripDealCategoryPrefix
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
    expect(calls).toEqual([['crm.category.list', { entityTypeId: 2, start: 0 }]])
  })

  it('pages past the 50-row cap via start/total (no silent drop of >50 funnels)', async () => {
    // 120 funnels across three 50-row pages; the loader must page until `total` is reached.
    const all = Array.from({ length: 120 }, (_, i) => ({ id: i }))
    const starts: number[] = []
    const call: RestCall = async (_method, params) => {
      const start = params.start as number
      starts.push(start)
      return { result: { categories: all.slice(start, start + 50) }, total: all.length }
    }
    const ids = await loadCategoryIds(2, call)
    expect(ids).toHaveLength(120)
    expect(ids[119]).toBe('119')
    expect(starts).toEqual([0, 50, 100]) // three pages, then total reached → stop
  })

  it('stops on an empty page even if total is inconsistent (no infinite loop)', async () => {
    const call: RestCall = async () => ({ result: { categories: [] }, total: 999 })
    expect(await loadCategoryIds(2, call)).toEqual([])
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

  it('excludes a SETTLED (paid) invoice stage, but keeps a WON deal (deals load negatives only)', async () => {
    const { call } = fakeCall({
      categories: { 31: [{ id: 11 }], 2: [{ id: 0 }] },
      statuses: {
        SMART_INVOICE_STAGE_11: [
          { STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' }, // unpaid/lost
          { STATUS_ID: 'DT31_11:P', SEMANTICS: 'S' }, // PAID — must be excluded now
          { STATUS_ID: 'DT31_11:N' } // open — kept
        ],
        DEAL_STAGE: [{ STATUS_ID: 'LOSE', SEMANTICS: 'F' }, { STATUS_ID: 'WON', SEMANTICS: 'S' }]
      }
    })
    const { predicate, diagnostics } = await buildPortalNegativeStagePredicate(call)
    expect(predicate('DT31_11:D')).toBe(true) // lost invoice
    expect(predicate('DT31_11:P')).toBe(true) // PAID invoice — now excluded (the fix)
    expect(predicate('DT31_11:N')).toBe(false) // open invoice — still a candidate
    expect(predicate('LOSE')).toBe(true) // lost deal
    expect(predicate('WON')).toBe(false) // WON deal is NOT excluded (settledness handled at payment level)
    // diagnostics count NEGATIVES only (settled must not mask a fail-open)
    expect(diagnostics.invoice).toEqual({ categories: 1, negativeStages: 1 })
    expect(diagnostics.deal).toEqual({ categories: 1, negativeStages: 1 })
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

  it('catches a lost DEFAULT-funnel deal whichever stage-id form comes back (C0:LOSE or LOSE)', async () => {
    const { call } = fakeCall({
      categories: { 31: [], 2: [{ id: 0 }] },
      statuses: { DEAL_STAGE: [{ STATUS_ID: 'LOSE', SEMANTICS: 'F' }] } // set holds the bare form
    })
    const { predicate } = await buildPortalNegativeStagePredicate(call)
    expect(predicate('LOSE')).toBe(true) // bare form (direct hit)
    expect(predicate('C0:LOSE')).toBe(true) // prefixed form (via stripDealCategoryPrefix)
    expect(predicate('C0:WON')).toBe(false) // positive stage stays kept even prefixed
  })
})

describe('stripDealCategoryPrefix', () => {
  it('strips a leading C<digits>: deal-category prefix', () => {
    expect(stripDealCategoryPrefix('C5:LOSE')).toBe('LOSE')
    expect(stripDealCategoryPrefix('C0:APOLOGY')).toBe('APOLOGY')
  })
  it('leaves bare deal codes and non-deal (invoice) ids unchanged', () => {
    expect(stripDealCategoryPrefix('LOSE')).toBe('LOSE')
    expect(stripDealCategoryPrefix('DT31_11:D')).toBe('DT31_11:D') // invoice id: no C<n>: prefix
    expect(stripDealCategoryPrefix('')).toBe('')
  })
})

describe('failOpenEntities (symmetric fail-open signal)', () => {
  it('flags an entity type with funnels but zero negatives — invoice AND deal', () => {
    expect(failOpenEntities({ invoice: { categories: 1, negativeStages: 0 }, deal: { categories: 2, negativeStages: 0 } }))
      .toEqual(['invoice', 'deal'])
  })
  it('flags only the broken side', () => {
    expect(failOpenEntities({ invoice: { categories: 1, negativeStages: 0 }, deal: { categories: 2, negativeStages: 3 } }))
      .toEqual(['invoice'])
    expect(failOpenEntities({ invoice: { categories: 1, negativeStages: 2 }, deal: { categories: 2, negativeStages: 0 } }))
      .toEqual(['deal'])
  })
  it('flags nothing when negatives exist for both entity types', () => {
    expect(failOpenEntities({ invoice: { categories: 1, negativeStages: 1 }, deal: { categories: 1, negativeStages: 1 } })).toEqual([])
  })
  it('flags an entity whose funnels could not be enumerated (categories === 0 → empty negative set is still a fail-open)', () => {
    expect(failOpenEntities({ invoice: { categories: 0, negativeStages: 0 }, deal: { categories: 0, negativeStages: 0 } })).toEqual(['invoice', 'deal'])
    expect(failOpenEntities({ invoice: { categories: 0, negativeStages: 0 }, deal: { categories: 2, negativeStages: 3 } })).toEqual(['invoice'])
  })
})
