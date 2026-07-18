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
    const { negative, categories, emptyCategories } = await loadEntityNegativeStages(31, id => `SMART_INVOICE_STAGE_${id}`, call)
    expect(categories).toBe(2)
    expect(emptyCategories).toBe(0) // both funnels have a negative stage
    expect([...negative].sort()).toEqual(['DT31_11:D', 'DT31_12:D'])
  })

  it('counts per-funnel empties (a funnel with zero negatives) for the granular fail-open signal (#242)', async () => {
    const { call } = fakeCall({
      categories: { 31: [{ id: 11 }, { id: 12 }] },
      statuses: {
        SMART_INVOICE_STAGE_11: [{ STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' }], // has a negative
        SMART_INVOICE_STAGE_12: [{ STATUS_ID: 'DT31_12:N' }] // trimmed / no negative → empty
      }
    })
    const { negative, categories, emptyCategories } = await loadEntityNegativeStages(31, id => `SMART_INVOICE_STAGE_${id}`, call)
    expect(categories).toBe(2)
    expect(negative.size).toBe(1) // aggregate is non-zero (funnel 11's negative masks funnel 12)
    expect(emptyCategories).toBe(1) // but funnel 12 came back empty → per-funnel signal fires
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
      invoice: { categories: 1, negativeStages: 1, emptyCategories: 0 },
      deal: { categories: 2, negativeStages: 2, emptyCategories: 0 }
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
    expect(diagnostics.invoice).toEqual({ categories: 1, negativeStages: 1, emptyCategories: 0 })
    expect(diagnostics.deal).toEqual({ categories: 1, negativeStages: 1, emptyCategories: 0 })
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
    expect(diagnostics.deal).toEqual({ categories: 1, negativeStages: 0, emptyCategories: 1 })
  })

  it('BATCHED path (#191): status.list fan-out goes through batch, same predicate/diagnostics, one batch per entity type', async () => {
    const { call, calls } = fakeCall({
      categories: { 31: [{ id: 11 }], 2: [{ id: 0 }, { id: 5 }] },
      statuses: {
        SMART_INVOICE_STAGE_11: [{ STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' }, { STATUS_ID: 'DT31_11:P', SEMANTICS: 'S' }],
        DEAL_STAGE: [{ STATUS_ID: 'LOSE', SEMANTICS: 'F' }],
        DEAL_STAGE_5: [{ STATUS_ID: 'C5:LOSE', SEMANTICS: 'F' }]
      }
    })
    // A batch that resolves each command via the SAME status map (order preserved).
    const statuses: Record<string, Array<Record<string, unknown>>> = {
      SMART_INVOICE_STAGE_11: [{ STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' }, { STATUS_ID: 'DT31_11:P', SEMANTICS: 'S' }],
      DEAL_STAGE: [{ STATUS_ID: 'LOSE', SEMANTICS: 'F' }],
      DEAL_STAGE_5: [{ STATUS_ID: 'C5:LOSE', SEMANTICS: 'F' }]
    }
    const batchSizes: number[] = []
    const batch = async (cmds: Array<{ method: string, params?: Record<string, unknown> }>) => {
      batchSizes.push(cmds.length)
      return cmds.map(c => ({ result: statuses[String((c.params!.filter as Record<string, unknown>).ENTITY_ID)] ?? [] }))
    }
    const { predicate, diagnostics } = await buildPortalNegativeStagePredicate(call, batch)
    // Same result as the sequential path
    expect(predicate('DT31_11:D')).toBe(true)
    expect(predicate('DT31_11:P')).toBe(true) // settled invoice excluded
    expect(predicate('LOSE')).toBe(true)
    expect(predicate('C5:LOSE')).toBe(true)
    expect(diagnostics).toEqual({
      invoice: { categories: 1, negativeStages: 1, emptyCategories: 0 },
      deal: { categories: 2, negativeStages: 2, emptyCategories: 0 }
    })
    // status.list did NOT go through the single-call transport — only category.list did
    expect(calls.every(([m]) => m === 'crm.category.list')).toBe(true)
    // one batch per entity type (invoice: 1 cmd, deal: 2 cmds)
    expect(batchSizes).toEqual([1, 2])
  })

  it('propagates a transport error', async () => {
    const call: RestCall = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(buildPortalNegativeStagePredicate(call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })

  it('unions a configured SMART PROCESS FAIL stage (disjoint DT<etid>_ namespace) + its diagnostics', async () => {
    const { call } = fakeCall({
      categories: { 31: [{ id: 11 }], 2: [{ id: 0 }], 1032: [{ id: 67 }] },
      statuses: {
        SMART_INVOICE_STAGE_11: [{ STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' }],
        DEAL_STAGE: [{ STATUS_ID: 'LOSE', SEMANTICS: 'F' }],
        DYNAMIC_1032_STAGE_67: [{ STATUS_ID: 'DT1032_67:FAIL', SEMANTICS: 'F' }, { STATUS_ID: 'DT1032_67:SUCCESS', SEMANTICS: 'S' }]
      }
    })
    const { predicate, diagnostics } = await buildPortalNegativeStagePredicate(call, null, 1032)
    expect(predicate('DT1032_67:FAIL')).toBe(true) // lost SP element — now excluded
    expect(predicate('DT1032_67:SUCCESS')).toBe(false) // SP negatives only (like deals)
    expect(predicate('DT31_11:D')).toBe(true) // invoice still works
    expect(predicate('LOSE')).toBe(true) // deal still works
    expect(diagnostics.smartProcess).toEqual({ categories: 1, negativeStages: 1, emptyCategories: 0 })
  })

  it('ignores a smart-entity misconfigured to the invoice/deal type (no bogus DYNAMIC_31/2 load, no spurious alert)', async () => {
    const { call, calls } = fakeCall({
      categories: { 31: [{ id: 11 }], 2: [{ id: 0 }] },
      statuses: {
        SMART_INVOICE_STAGE_11: [{ STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' }],
        DEAL_STAGE: [{ STATUS_ID: 'LOSE', SEMANTICS: 'F' }]
      }
    })
    const { diagnostics } = await buildPortalNegativeStagePredicate(call, null, 31)
    expect(diagnostics.smartProcess).toBeUndefined() // treated as not-configured-for-SP
    // exactly two category.list calls (invoice 31 + deal 2) — no extra SP load was attempted
    const catCalls = calls.filter(([m]) => m === 'crm.category.list')
    expect(catCalls.map(([, p]) => p.entityTypeId).sort()).toEqual([2, 31])
  })

  it('omits smartProcess diagnostics when no entityTypeId is configured (unchanged behaviour)', async () => {
    const { call } = fakeCall({
      categories: { 31: [{ id: 11 }], 2: [{ id: 0 }] },
      statuses: {
        SMART_INVOICE_STAGE_11: [{ STATUS_ID: 'DT31_11:D', SEMANTICS: 'F' }],
        DEAL_STAGE: [{ STATUS_ID: 'LOSE', SEMANTICS: 'F' }]
      }
    })
    const { predicate, diagnostics } = await buildPortalNegativeStagePredicate(call, null, null)
    expect(diagnostics.smartProcess).toBeUndefined()
    expect(predicate('DT1032_67:FAIL')).toBe(false) // SP not loaded → not excluded (fail-open, unchanged)
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
  const d = (categories: number, negativeStages: number, emptyCategories = 0) => ({ categories, negativeStages, emptyCategories })
  it('flags an entity type with funnels but zero negatives — invoice AND deal', () => {
    expect(failOpenEntities({ invoice: d(1, 0), deal: d(2, 0) })).toEqual(['invoice', 'deal'])
  })
  it('flags only the broken side', () => {
    expect(failOpenEntities({ invoice: d(1, 0), deal: d(2, 3) })).toEqual(['invoice'])
    expect(failOpenEntities({ invoice: d(1, 2), deal: d(2, 0) })).toEqual(['deal'])
  })
  it('flags nothing when negatives exist for both entity types', () => {
    expect(failOpenEntities({ invoice: d(1, 1), deal: d(1, 1) })).toEqual([])
  })
  it('flags an entity whose funnels could not be enumerated (categories === 0 → empty negative set is still a fail-open)', () => {
    expect(failOpenEntities({ invoice: d(0, 0), deal: d(0, 0) })).toEqual(['invoice', 'deal'])
    expect(failOpenEntities({ invoice: d(0, 0), deal: d(2, 3) })).toEqual(['invoice'])
  })
  it('flags a type whose AGGREGATE has negatives but ONE funnel came back empty (#242 per-funnel signal)', () => {
    // 3 deal funnels, aggregate 3 negatives, but one funnel trimmed → emptyCategories=1 must flag.
    expect(failOpenEntities({ invoice: d(2, 2, 0), deal: d(3, 3, 1) })).toEqual(['deal'])
    // both healthy (no empties) → nothing flagged even with many funnels
    expect(failOpenEntities({ invoice: d(2, 2, 0), deal: d(3, 5, 0) })).toEqual([])
  })
  it('participates in the signal only when smartProcess is present (configured)', () => {
    // absent smartProcess ⇒ never flagged (SP simply not loaded)
    expect(failOpenEntities({ invoice: d(1, 1), deal: d(1, 1) })).toEqual([])
    // present but broken (zero negatives) ⇒ flagged as 'smart-process'
    expect(failOpenEntities({ invoice: d(1, 1), deal: d(1, 1), smartProcess: d(1, 0) })).toEqual(['smart-process'])
    // present and healthy ⇒ not flagged
    expect(failOpenEntities({ invoice: d(1, 1), deal: d(1, 1), smartProcess: d(1, 2) })).toEqual([])
  })
})
