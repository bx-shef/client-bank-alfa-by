import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  handleCrmSyncJob, handleEventJob, handleFetchJob, handleParseJob, type HandlerDeps
} from '../server/queue/handlers'
import {
  DEMO_ACCOUNT_PREFIX, buildDemoFetchJobs, cronIntervalMs, demoDelayMs, demoItems, demoTickMs, isDemoAccount, planFetches
} from '../server/queue/cron'
import type { CrmSyncJob, FetchJob } from '../server/queue/topology'
import type { ChatSettings, PortalSettings, RecognitionSettings } from '../app/utils/settings'
import type { RecognitionIntent } from '../app/utils/recognitionIntent'
import type { IntentResolution } from '../server/utils/intentResolver'

function item(docId: string, direction: 'credit' | 'debit' = 'credit', purpose = 'p'): StatementItem {
  return {
    account: 'A', docId, direction, amount: 10, currency: 'BYN', purpose,
    counterparty: { name: 'C', unp: '1', account: 'BY1' }, acceptDate: '2026-07-01T00:00:00.000Z'
  }
}

/** Options to shape the fake CRM-side behaviour for a test. */
interface FakeOpts {
  batch?: StatementItem[]
  /** company id returned by findCompany (default 'CO'); null = unmatched. */
  company?: string | null
  /** dedup keys already written (getActivityId returns a stored id for these). */
  alreadyWritten?: Set<string>
  /** chat settings; default announces both directions. null ⇒ getPortalSettings
   *  returns null (settings unavailable — chat AND recognition off). */
  chat?: ChatSettings | null
  /** recognition settings; default = no matrices (recognition off). */
  recognition?: RecognitionSettings
  /** what resolveIntents returns (one resolution per intent); default []. */
  resolve?: IntentResolution[]
  /** negative-stage predicate returned by loadNegativeStagePredicate; default null
   *  (unavailable → resolution proceeds unfiltered). */
  negativeStage?: ((stageId: string) => boolean) | null
}

/** Recording fake deps; fetchStatement/parseFile return the given batch. By default
 *  findCompany matches a company and writeActivity mints a sequential activity id. */
function fakeDeps(opts: FakeOpts | StatementItem[] = {}): { deps: HandlerDeps, calls: Record<string, unknown[]> } {
  const o: FakeOpts = Array.isArray(opts) ? { batch: opts } : opts
  const batch = o.batch ?? []
  const company = o.company === undefined ? 'CO' : o.company
  const written = new Map<string, string>() // dedupKey → activityId (persistent dedup)
  for (const k of o.alreadyWritten ?? []) written.set(k, `pre-${k}`)
  let nextId = 1
  // default chat: a target set + both directions → every created op is announced
  // (keeps pre-gating chat assertions valid; gating is exercised by its own tests).
  const chat = o.chat === undefined
    ? { dialogId: 'chat1', rules: { directions: ['credit', 'debit'] as const } }
    : o.chat
  const recognition: RecognitionSettings = o.recognition ?? { alphabet: 'cyrillic', matrices: [], configFields: {} }
  // null chat ⇒ getPortalSettings returns null (settings unavailable); else a full blob.
  const settings: PortalSettings | null = chat === null ? null : { chat, errorChat: { dialogId: '' }, recognition }
  const calls: Record<string, unknown[]> = { crm: [], activity: [], chat: [], del: [], save: [], remember: [], find: [], settings: [], recognized: [], resolve: [], resolvedLog: [], negStage: [], allocLog: [] }
  const negativeStage = o.negativeStage === undefined ? null : o.negativeStage
  const deps: HandlerDeps = {
    fetchStatement: async () => batch,
    parseFile: async () => batch,
    findCompany: async (it, memberId) => {
      calls.find.push([it.docId, memberId])
      return company
    },
    writeActivity: async (it, companyId, memberId) => {
      if (!companyId) return null // no company → no owner → nothing written
      const id = `act-${nextId++}`
      calls.activity.push([it.docId, companyId, memberId, id])
      return id
    },
    getPortalSettings: async (memberId) => {
      calls.settings.push(memberId)
      return settings
    },
    onRecognized: (it, intents: RecognitionIntent[], memberId) => {
      calls.recognized.push([it.docId, intents.map(i => `${i.kind}:${i.value}:${i.route.strategy}`), memberId])
    },
    resolveIntents: async (intents, companyId, memberId, isNegativeStage) => {
      calls.resolve.push([companyId, intents.map(i => i.kind), memberId, isNegativeStage ? 'staged' : 'unfiltered'])
      return o.resolve ?? []
    },
    loadNegativeStagePredicate: async (memberId) => {
      calls.negStage.push(memberId)
      return negativeStage
    },
    onResolved: (it, resolutions, memberId) => {
      calls.resolvedLog.push([it.docId, resolutions.map(r => `${r.kind}:${r.status}:${r.candidates.length}`), memberId])
    },
    onAllocationDecision: (it, decision, triggerTargets, memberId) => {
      const tag = decision.action === 'allocate' ? `allocate:${decision.target.id}:${decision.ambiguous ? 'amb' : 'one'}` : decision.action
      calls.allocLog.push([it.docId, tag, triggerTargets, memberId])
    },
    notifyChat: async (it, _dialogId, memberId) => {
      calls.chat.push([it.docId, memberId])
    },
    getActivityId: async (_memberId, key) => written.get(key) ?? null,
    rememberActivity: async (_memberId, key, activityId) => {
      written.set(key, activityId)
      calls.remember.push([key, activityId])
    },
    savePortal: async (job) => {
      calls.save.push(job.memberId)
    },
    deletePortal: async (m) => {
      calls.del.push(m)
    },
    enqueueCrmSync: async (job) => {
      calls.crm.push(job)
      return true
    }
  }
  return { deps, calls }
}

const CREDS = { accessToken: 'A', refreshTokenEnc: 'ENC', expiresAt: 1, applicationToken: 'T' }

describe('handleEventJob', () => {
  it('deletes portal data on uninstall (always)', async () => {
    const { deps, calls } = fakeDeps()
    const r = await handleEventJob({ memberId: 'M', domain: 'd', kind: 'ONAPPUNINSTALL', ts: '1' }, deps)
    expect(r).toEqual({ kind: 'ONAPPUNINSTALL', cleaned: true, registered: false })
    expect(calls.del).toEqual(['M'])
    expect(calls.save).toEqual([])
  })
  it('registers the portal on install (persists credentials)', async () => {
    const { deps, calls } = fakeDeps()
    const r = await handleEventJob({ memberId: 'M', domain: 'd', kind: 'ONAPPINSTALL', ts: '1', credentials: CREDS }, deps)
    expect(r).toEqual({ kind: 'ONAPPINSTALL', cleaned: false, registered: true })
    expect(calls.save).toEqual(['M'])
    expect(calls.del).toEqual([])
  })
  it('does not register an install job missing credentials', async () => {
    const { deps, calls } = fakeDeps()
    const r = await handleEventJob({ memberId: 'M', domain: 'd', kind: 'ONAPPINSTALL', ts: '1' }, deps)
    expect(r.registered).toBe(false)
    expect(calls.save).toEqual([])
  })
})

describe('handleFetchJob / handleParseJob → crm-sync', () => {
  const fetchJob: FetchJob = { memberId: 'M', providerId: 'alfa-by', account: 'ACC', dateFrom: '2026-07-01', dateTo: '2026-07-31' }
  it('chains a non-empty batch onto crm-sync with a stable batchId', async () => {
    const { deps, calls } = fakeDeps([item('d1'), item('d2')])
    const r = await handleFetchJob(fetchJob, deps)
    expect(r).toEqual({ fetched: 2, chained: true })
    expect((calls.crm[0] as CrmSyncJob).batchId).toBe('ACC:2026-07-01:2026-07-31')
    expect((calls.crm[0] as CrmSyncJob).source).toBe('fetch')
  })
  it('does not chain an empty batch', async () => {
    const { deps, calls } = fakeDeps([])
    expect(await handleFetchJob(fetchJob, deps)).toEqual({ fetched: 0, chained: false })
    expect(calls.crm).toEqual([])
  })
  it('parse uses the file hash as batchId', async () => {
    const { deps, calls } = fakeDeps([item('d1')])
    const r = await handleParseJob({ memberId: 'M', providerId: 'manual', fileName: 'k.txt', contentBase64: 'AAAA', fileHash: 'HASH' }, deps)
    expect(r).toEqual({ parsed: 1, chained: true })
    expect((calls.crm[0] as CrmSyncJob).batchId).toBe('HASH')
  })
})

describe('handleCrmSyncJob', () => {
  const job = (items: StatementItem[]): CrmSyncJob => ({
    memberId: 'M', providerId: 'alfa-by', source: 'fetch', batchId: 'b', items
  })

  it('dedupes within the batch and writes+remembers+notifies per unique op', async () => {
    const { deps, calls } = fakeDeps()
    const r = await handleCrmSyncJob(
      job([item('d1', 'credit'), item('d1', 'credit'), item('d2', 'debit')]), // d1 duplicated
      deps
    )
    expect(r).toEqual({ processed: 2, created: 2, notified: 2, skipped: 0, unmatched: 0, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, credits: 1, debits: 1 })
    expect(calls.activity).toEqual([['d1', 'CO', 'M', 'act-1'], ['d2', 'CO', 'M', 'act-2']])
    expect(calls.remember).toEqual([['A|d1', 'act-1'], ['A|d2', 'act-2']])
    // All three CRM ops receive the portal memberId ('M').
    expect(calls.find).toEqual([['d1', 'M'], ['d2', 'M']])
    expect(calls.chat).toEqual([['d1', 'M'], ['d2', 'M']])
  })

  it('is idempotent across job redelivery (real round-trip through the store)', async () => {
    const { deps, calls } = fakeDeps() // the fake persists remembered keys across calls
    const j = job([item('d1'), item('d2')])
    const first = await handleCrmSyncJob(j, deps)
    expect(first).toMatchObject({ created: 2, notified: 2, skipped: 0, unmatched: 0 })
    // Redeliver the SAME job: everything is now remembered → all skipped, no side effects.
    const second = await handleCrmSyncJob(j, deps)
    expect(second).toEqual({ processed: 2, created: 0, notified: 0, skipped: 2, unmatched: 0, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, credits: 2, debits: 0 })
    expect(calls.activity).toHaveLength(2) // still just the first run's two writes
    expect(calls.chat).toHaveLength(2) // no re-notify on redelivery
    expect(calls.find).toHaveLength(2) // skipped ops don't even reach findCompany
  })

  it('skips ops already written (persistent dedup) — no re-write, no re-notify', async () => {
    const { deps, calls } = fakeDeps({ alreadyWritten: new Set(['A|d1']) })
    const r = await handleCrmSyncJob(job([item('d1'), item('d2')]), deps)
    expect(r).toEqual({ processed: 2, created: 1, notified: 1, skipped: 1, unmatched: 0, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, credits: 2, debits: 0 })
    // d1 was skipped BEFORE findCompany: only d2 hit findCompany/writeActivity/chat.
    expect(calls.find).toEqual([['d2', 'M']])
    expect(calls.chat).toEqual([['d2', 'M']])
    expect(calls.remember).toEqual([['A|d2', 'act-1']])
  })

  it('counts unmatched ops (no company) and does NOT remember or notify them', async () => {
    const { deps, calls } = fakeDeps({ company: null })
    const r = await handleCrmSyncJob(job([item('d1'), item('d2')]), deps)
    expect(r).toEqual({ processed: 2, created: 0, notified: 0, skipped: 0, unmatched: 2, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, credits: 2, debits: 0 })
    expect(calls.activity).toEqual([]) // nothing written
    expect(calls.remember).toEqual([]) // so nothing remembered → retried on redelivery
    expect(calls.chat).toEqual([])
  })

  it('handles a mixed batch: one skipped, one new, one unmatched (counters do not leak)', async () => {
    // d1 pre-written (skip); d2 matches a company (create); d3 has no company (unmatched).
    const { deps, calls } = fakeDeps({
      alreadyWritten: new Set(['A|d1']),
      company: null // default no-match…
    })
    // …but let d2 match: override findCompany to match only d2.
    deps.findCompany = async it => (it.docId === 'd2' ? 'CO' : null)
    const r = await handleCrmSyncJob(job([item('d1', 'credit'), item('d2', 'credit'), item('d3', 'debit')]), deps)
    expect(r).toEqual({ processed: 3, created: 1, notified: 1, skipped: 1, unmatched: 1, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, credits: 2, debits: 1 })
    expect(calls.remember).toEqual([['A|d2', 'act-1']])
    expect(calls.chat).toEqual([['d2', 'M']])
  })

  it('resolves portal settings ONCE per job, not per operation (#16 нюанс 1)', async () => {
    const { deps, calls } = fakeDeps()
    await handleCrmSyncJob(job([item('d1'), item('d2'), item('d3')]), deps)
    expect(calls.settings).toEqual(['M']) // one read feeds chat + recognition for the batch
  })

  it('no announcement when no chat target is set (empty dialogId)', async () => {
    const { deps, calls } = fakeDeps({ chat: { dialogId: '', rules: { directions: ['credit'] } } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit')]), deps)
    expect(r).toMatchObject({ created: 1 })
    expect(calls.chat).toEqual([]) // written, but not announced
  })

  it('no announcement when chat settings are null (unavailable)', async () => {
    const { deps, calls } = fakeDeps({ chat: null })
    await handleCrmSyncJob(job([item('d1', 'credit')]), deps)
    expect(calls.chat).toEqual([])
  })

  it('rules gate the announcement: direction / excluded account / excluded purpose', async () => {
    // directions: credits only → a created DEBIT is written but not announced.
    const dir = fakeDeps({ chat: { dialogId: 'c', rules: { directions: ['credit'] } } })
    await handleCrmSyncJob(job([item('d1', 'credit'), item('d2', 'debit')]), dir.deps)
    expect(dir.calls.chat).toEqual([['d1', 'M']])

    // excluded account (item.account = 'A') → silenced.
    const acc = fakeDeps({ chat: { dialogId: 'c', rules: { directions: ['credit'], excludeAccounts: ['A'] } } })
    await handleCrmSyncJob(job([item('d1', 'credit')]), acc.deps)
    expect(acc.calls.chat).toEqual([])

    // excluded purpose substring (item.purpose = 'p') → silenced.
    const pur = fakeDeps({ chat: { dialogId: 'c', rules: { directions: ['credit'], excludePurposePatterns: ['p'] } } })
    await handleCrmSyncJob(job([item('d1', 'credit')]), pur.deps)
    expect(pur.calls.chat).toEqual([])
  })

  // Recognition intent slice (§4, #109): recognize identifiers in the purpose by the
  // portal's matrices and route each. LOG-ONLY — does not change created/unmatched.
  const invoiceMatrix: RecognitionSettings = {
    alphabet: 'cyrillic', configFields: {}, matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' }]
  }

  it('recognizes an identifier and reports its routed intent (log-only)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'Оплата по счету СЧ-1234')]), deps)
    expect(r.recognized).toBe(1)
    expect(r).toMatchObject({ created: 1, unmatched: 0 }) // recognition does not alter the write path
    expect(calls.recognized).toEqual([['d1', ['invoice-number:СЧ-1234:by-number'], 'M']])
  })

  it('does not recognize when no matrix matches → recognized 0, no intent reported', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'просто перевод без номера')]), deps)
    expect(r.recognized).toBe(0)
    expect(calls.recognized).toEqual([])
  })

  it('recognition off (no matrices) → never calls onRecognized', async () => {
    const { deps, calls } = fakeDeps() // default recognition = empty matrices
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'Оплата по счету СЧ-1234')]), deps)
    expect(r.recognized).toBe(0)
    expect(calls.recognized).toEqual([])
  })

  it('settings unavailable (null) → recognition off too', async () => {
    const { deps, calls } = fakeDeps({ chat: null })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'Оплата по счету СЧ-1234')]), deps)
    expect(r.recognized).toBe(0)
    expect(calls.recognized).toEqual([])
  })

  it('counts recognized per OPERATION, not per identifier (≥2 matches → recognized 1, one report)', async () => {
    const twoKinds: RecognitionSettings = {
      alphabet: 'cyrillic', configFields: {},
      matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' }, { mask: 'Д-dd', kind: 'deal-id' }]
    }
    const { deps, calls } = fakeDeps({ recognition: twoKinds })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-1234 по сделке Д-77')]), deps)
    expect(r.recognized).toBe(1) // one op, though two identifiers matched
    expect(calls.recognized).toHaveLength(1) // onRecognized fired ONCE with both intents
    expect((calls.recognized[0] as unknown[])[1]).toEqual([
      'invoice-number:СЧ-1234:by-number', 'deal-id:Д-77:by-id'
    ])
  })

  it('recognizes an unmatched op too (recognition is independent of company match)', async () => {
    const { deps } = fakeDeps({ recognition: invoiceMatrix, company: null })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-1234')]), deps)
    expect(r).toMatchObject({ unmatched: 1, created: 0, recognized: 1 })
  })

  it('reports intent for every unique op with a match, independent of the dedup skip', async () => {
    // d1 already written (skip path) — recognition still runs on it (it's about the op).
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, alreadyWritten: new Set(['A|d1']) })
    const r = await handleCrmSyncJob(job([
      item('d1', 'credit', 'счет СЧ-0001'), item('d2', 'credit', 'счет СЧ-0002')
    ]), deps)
    expect(r).toMatchObject({ skipped: 1, created: 1, recognized: 2 })
    expect(calls.recognized.map(c => (c as unknown[])[0])).toEqual(['d1', 'd2'])
  })

  // Intent RESOLUTION slice (§4 → #109 lookup wired into crm-sync). LOG/COUNT only —
  // no allocation written. Gated behind the dedup skip + a matched company.
  const hit: IntentResolution[] = [
    { kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved', candidates: [{ kind: 'invoice', id: '7', amount: 100, currency: 'BYN' }] }
  ]

  it('resolves recognized intents for a matched op (scoped to the company) and counts a hit', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: hit })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ recognized: 1, resolved: 1, created: 1 })
    expect(calls.resolve).toEqual([['CO', ['invoice-number'], 'M', 'unfiltered']]) // companyId + intent kinds (no predicate → unfiltered)
    expect(calls.resolvedLog).toEqual([['d1', ['invoice-number:resolved:1'], 'M']])
  })

  it('does not increment resolved when no candidate is found (resolution ran, empty)', async () => {
    const empty: IntentResolution[] = [{ kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved', candidates: [] }]
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: empty })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ recognized: 1, resolved: 0 })
    expect(calls.resolve).toHaveLength(1) // still attempted
    expect(calls.resolvedLog).toHaveLength(1)
  })

  it('does NOT resolve an unmatched op (no company → no IDOR scope)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: hit, company: null })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ recognized: 1, resolved: 0, unmatched: 1 })
    expect(calls.resolve).toEqual([]) // never called without a company
  })

  it('does NOT resolve an op skipped by persistent dedup (no re-query on redelivery)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: hit, alreadyWritten: new Set(['A|d1']) })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ recognized: 1, resolved: 0, skipped: 1 })
    expect(calls.resolve).toEqual([]) // skipped before findCompany/resolveIntents
  })

  it('does not resolve when recognition found nothing (no intents → no lookup)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: hit })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'без номера')]), deps)
    expect(r).toMatchObject({ recognized: 0, resolved: 0, created: 1 })
    expect(calls.resolve).toEqual([])
  })

  it('counts resolved ONCE per op even when several intents (or candidates) match', async () => {
    // two intents, only one yields a candidate → resolved += 1 (per op, not per hit).
    const mixed: IntentResolution[] = [
      { kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved', candidates: [{ kind: 'invoice', id: '7', amount: 100, currency: 'BYN' }, { kind: 'invoice', id: '8', amount: 100, currency: 'BYN' }] },
      { kind: 'deal-id', value: '55', status: 'resolved', candidates: [] }
    ]
    const twoKinds: RecognitionSettings = {
      alphabet: 'cyrillic', configFields: {},
      matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' }, { mask: 'Д-dd', kind: 'deal-id' }]
    }
    const { deps } = fakeDeps({ recognition: twoKinds, resolve: mixed })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001 по сделке Д-55')]), deps)
    expect(r.recognized).toBe(1)
    expect(r.resolved).toBe(1) // one op, though two intents + two candidates
  })

  it('caps the intents sent to REST at MAX_RESOLVED_INTENTS_PER_OP (payer-controlled purpose)', async () => {
    // mask `dd` + a purpose with >10 distinct 2-digit numbers → >10 recognized intents.
    const twoDigit: RecognitionSettings = { alphabet: 'cyrillic', configFields: {}, matrices: [{ mask: 'dd', kind: 'deal-id' }] }
    const purpose = Array.from({ length: 20 }, (_, i) => String(10 + i)).join(' ') // 10..29 → 20 distinct
    const { deps, calls } = fakeDeps({ recognition: twoDigit, resolve: [] })
    await handleCrmSyncJob(job([item('d1', 'credit', purpose)]), deps)
    const sentKinds = (calls.resolve[0] as unknown[])[1] as string[]
    expect(sentKinds.length).toBe(10) // capped, though 20 were recognized
  })

  // Negative-stage filtering slice (§2, #109): the predicate (union of invoice + deal
  // fail/lost stages) is loaded ONCE per job and threaded into resolveIntents.
  it('threads the negative-stage predicate into resolveIntents when available', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: hit, negativeStage: () => false })
    await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect((calls.resolve[0] as unknown[])[3]).toBe('staged') // predicate passed through
    expect(calls.negStage).toEqual(['M'])
  })

  it('loads the negative-stage predicate AT MOST ONCE per job (memoized across ops)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: hit, negativeStage: () => false })
    await handleCrmSyncJob(job([
      item('d1', 'credit', 'счет СЧ-0001'), item('d2', 'credit', 'счет СЧ-0002'), item('d3', 'credit', 'счет СЧ-0003')
    ]), deps)
    expect(calls.resolve).toHaveLength(3) // all three ops resolved
    expect(calls.negStage).toEqual(['M']) // predicate loaded once, reused
  })

  it('does not load the negative-stage predicate when no op resolves (lazy, no company)', async () => {
    // no company → resolution gated off → predicate never loaded (saves the REST calls).
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: hit, company: null })
    await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(calls.resolve).toEqual([])
    expect(calls.negStage).toEqual([]) // never called — nothing to filter
  })

  it('does not load the negative-stage predicate when a matched op recognizes nothing (lazy gate)', async () => {
    // company matches but the purpose yields no intent → the `intents.length > 0` half of
    // the gate holds it off (guards against a regression that loads on company-match alone).
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: hit })
    await handleCrmSyncJob(job([item('d1', 'credit', 'без номера счета')]), deps)
    expect(calls.resolve).toEqual([])
    expect(calls.negStage).toEqual([])
  })

  it('memoizes a NULL predicate too — loaded once per job, every op unfiltered', async () => {
    // the fragile path: a null (unavailable) result must be memoized, not re-fetched per op.
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: hit, negativeStage: null })
    await handleCrmSyncJob(job([
      item('d1', 'credit', 'счет СЧ-0001'), item('d2', 'credit', 'счет СЧ-0002'), item('d3', 'credit', 'счет СЧ-0003')
    ]), deps)
    expect(calls.resolve).toHaveLength(3)
    expect(calls.negStage).toEqual(['M']) // loaded ONCE despite null, not per-op
    expect((calls.resolve as unknown[][]).every(c => c[3] === 'unfiltered')).toBe(true)
  })

  it('resolves unfiltered when the predicate is unavailable (null → no stage filtering)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: hit, negativeStage: null })
    await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect((calls.resolve[0] as unknown[])[3]).toBe('unfiltered')
    expect(calls.negStage).toEqual(['M']) // attempted once, returned null
  })

  // Allocation DECISION slice (§2, #109). resolveAllocation over the resolved candidates;
  // amount targets (invoice/deal-payment) match by exact amount+currency, trigger targets
  // (deal/smart-process) fire unconditionally. LOG/COUNT only — nothing is written.
  const invAt = (id: string, amount: number): IntentResolution => ({
    kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved',
    candidates: [{ kind: 'invoice', id, amount, currency: 'BYN' }]
  })

  it('counts an exact amount match as allocatable (allocate to that target)', async () => {
    // op amount is 10 BYN (item helper); candidate amount 10 → exact.
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: [invAt('7', 10)] })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ resolved: 1, allocatable: 1, ambiguous: 0, manual: 0 })
    expect(calls.allocLog).toEqual([['d1', 'allocate:7:one', 0, 'M']])
  })

  it('flags ambiguous when >1 distinct target matches (allocate to smallest id)', async () => {
    const two: IntentResolution[] = [{
      kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved',
      candidates: [{ kind: 'invoice', id: '9', amount: 10, currency: 'BYN' }, { kind: 'invoice', id: '5', amount: 10, currency: 'BYN' }]
    }]
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: two })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ allocatable: 1, ambiguous: 1, manual: 0 })
    expect(calls.allocLog).toEqual([['d1', 'allocate:5:amb', 0, 'M']]) // smallest id, flagged ambiguous
  })

  it('counts amount candidates with no exact match as manual (partial/group payment)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: [invAt('7', 100)] }) // 100 ≠ op 10
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ allocatable: 0, ambiguous: 0, manual: 1 })
    expect(calls.allocLog).toEqual([['d1', 'manual', 0, 'M']])
  })

  it('a trigger target (deal) is allocatable unconditionally, bypassing amount match', async () => {
    const dealMatrix: RecognitionSettings = { alphabet: 'cyrillic', configFields: {}, matrices: [{ mask: 'Д-dd', kind: 'deal-id' }] }
    const trig: IntentResolution[] = [{ kind: 'deal-id', value: '55', status: 'resolved', candidates: [{ kind: 'deal', id: '3', amount: 0, currency: '' }] }]
    const { deps, calls } = fakeDeps({ recognition: dealMatrix, resolve: trig })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'сделка Д-55')]), deps)
    expect(r).toMatchObject({ allocatable: 1, ambiguous: 0, manual: 0 })
    expect(calls.allocLog).toEqual([['d1', 'none', 1, 'M']]) // no amount target, 1 trigger fires
  })

  it('does not decide allocation when nothing resolved (no candidates)', async () => {
    const empty: IntentResolution[] = [{ kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved', candidates: [] }]
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: empty })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ resolved: 0, allocatable: 0, manual: 0 })
    expect(calls.allocLog).toEqual([]) // no candidates → no allocation decision
  })

  it('mixed op: exact amount match AND a trigger → allocatable once (trigger not double-counted)', async () => {
    const mixed: IntentResolution[] = [{
      kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved',
      candidates: [{ kind: 'invoice', id: '7', amount: 10, currency: 'BYN' }, { kind: 'deal', id: '3', amount: 0, currency: '' }]
    }]
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: mixed })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ allocatable: 1, ambiguous: 0, manual: 0 }) // NOT 2
    expect(calls.allocLog).toEqual([['d1', 'allocate:7:one', 1, 'M']]) // triggerTargets=1 logged alongside
  })

  it('mixed op: NO amount match but a trigger fires → allocatable, manual stays 0 (trigger overrides)', async () => {
    const mixed: IntentResolution[] = [{
      kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved',
      candidates: [{ kind: 'invoice', id: '7', amount: 100, currency: 'BYN' }, { kind: 'deal', id: '3', amount: 0, currency: '' }]
    }]
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: mixed })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ allocatable: 1, manual: 0 }) // trigger wins over manual
    expect(calls.allocLog).toEqual([['d1', 'manual', 1, 'M']]) // amount decision is manual, +1 trigger
  })

  it('currency mismatch (right amount, wrong currency) → manual', async () => {
    const wrongCur: IntentResolution[] = [{
      kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved',
      candidates: [{ kind: 'invoice', id: '7', amount: 10, currency: 'USD' }] // op is 10 BYN
    }]
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: wrongCur })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ allocatable: 0, manual: 1 })
    expect(calls.allocLog).toEqual([['d1', 'manual', 0, 'M']])
  })

  it('a deal-payment amount target routes through resolveAllocation (exact match)', async () => {
    const pay: IntentResolution[] = [{
      kind: 'payment-number', value: '1/2', status: 'resolved',
      candidates: [{ kind: 'deal-payment', id: '4', amount: 10, currency: 'BYN', dealId: '2', accountNumber: '1/2' }]
    }]
    const payMatrix: RecognitionSettings = { alphabet: 'cyrillic', configFields: {}, matrices: [{ mask: 'd/d', kind: 'payment-number' }] }
    const { deps, calls } = fakeDeps({ recognition: payMatrix, resolve: pay })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата 1/2')]), deps)
    expect(r).toMatchObject({ allocatable: 1, ambiguous: 0, manual: 0 })
    expect(calls.allocLog).toEqual([['d1', 'allocate:4:one', 0, 'M']])
  })

  it('invoice + deal-payment of the SAME deal collapse to one target (not ambiguous)', async () => {
    const same: IntentResolution[] = [{
      kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved',
      candidates: [
        { kind: 'invoice', id: '7', amount: 10, currency: 'BYN', dealId: '2' },
        { kind: 'deal-payment', id: '4', amount: 10, currency: 'BYN', dealId: '2' }
      ]
    }]
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: same })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ allocatable: 1, ambiguous: 0 }) // invoice preferred, payment collapsed
    expect(calls.allocLog).toEqual([['d1', 'allocate:7:one', 0, 'M']])
  })

  it('accumulates allocation counters across a multi-op batch (allocate + manual + ambiguous)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix })
    // per-op resolutions keyed by the recognized value (each op has a distinct number).
    deps.resolveIntents = async (intents) => {
      const v = intents[0]?.value
      if (v === 'СЧ-0001') return [invAt('7', 10)] // exact → allocatable
      if (v === 'СЧ-0002') return [invAt('7', 100)] // no exact → manual
      return [{ // two distinct exact matches → ambiguous
        kind: 'invoice-number', value: v!, status: 'resolved',
        candidates: [{ kind: 'invoice', id: '9', amount: 10, currency: 'BYN' }, { kind: 'invoice', id: '5', amount: 10, currency: 'BYN' }]
      }]
    }
    const r = await handleCrmSyncJob(job([
      item('d1', 'credit', 'счет СЧ-0001'), item('d2', 'credit', 'счет СЧ-0002'), item('d3', 'credit', 'счет СЧ-0003')
    ]), deps)
    expect(r).toMatchObject({ resolved: 3, allocatable: 2, ambiguous: 1, manual: 1 })
    expect(calls.allocLog).toEqual([
      ['d1', 'allocate:7:one', 0, 'M'], ['d2', 'manual', 0, 'M'], ['d3', 'allocate:5:amb', 0, 'M']
    ])
  })

  it('propagates a resolveIntents error (fails the job before writeActivity)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix })
    deps.resolveIntents = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
    expect(calls.activity).toEqual([]) // never reached writeActivity for this op
    expect(calls.remember).toEqual([])
  })
})

describe('cron helpers', () => {
  it('cronIntervalMs floors bad input to a sane default', () => {
    expect(cronIntervalMs(2)).toBe(120_000)
    expect(cronIntervalMs(0)).toBe(300_000)
    expect(cronIntervalMs(Number.NaN)).toBe(300_000)
  })
  it('demoTickMs is seconds-based, floored to 1s, default 5s', () => {
    expect(demoTickMs(3)).toBe(3_000)
    expect(demoTickMs(0)).toBe(5_000) // bad → default 5s
    expect(demoTickMs(Number.NaN)).toBe(5_000)
    expect(demoTickMs(0.4)).toBe(1_000) // floor to 1s
  })
  it('demoDelayMs clamps to [0,5000], default 600', () => {
    expect(demoDelayMs(600)).toBe(600)
    expect(demoDelayMs(0)).toBe(0) // 0 disables the pause
    expect(demoDelayMs(-100)).toBe(0)
    expect(demoDelayMs(99_999)).toBe(5_000)
    expect(demoDelayMs(Number.NaN)).toBe(600)
  })
  it('planFetches yields one job per (portal, account); empty when no accounts', () => {
    expect(planFetches([], '2026-07-01', '2026-07-01')).toEqual([])
    const jobs = planFetches(
      [{ memberId: 'M', providerId: 'alfa-by', accounts: ['A1', 'A2'] }], '2026-07-01', '2026-07-02'
    )
    expect(jobs.map(j => j.account)).toEqual(['A1', 'A2'])
  })
  it('isDemoAccount flags only DEMO- accounts (the live CRM gate)', () => {
    expect(isDemoAccount('DEMO-t1-1')).toBe(true)
    expect(isDemoAccount(`${DEMO_ACCOUNT_PREFIX}x`)).toBe(true)
    expect(isDemoAccount('BY13REAL')).toBe(false)
    expect(isDemoAccount('')).toBe(false)
  })
  it('buildDemoFetchJobs makes N demo jobs, demoItems emits ops only for demo accounts', () => {
    const jobs = buildDemoFetchJobs('demo-portal', 3, '2026-07-01', 't1')
    expect(jobs).toHaveLength(3)
    expect(jobs[0]!.account.startsWith(DEMO_ACCOUNT_PREFIX)).toBe(true)
    expect(demoItems(jobs[0]!)).toHaveLength(2)
    // a non-demo account yields nothing (real transport is stage 3/5)
    expect(demoItems({ ...jobs[0]!, account: 'BY-real' })).toEqual([])
  })
  it('different ticks produce distinct accounts (so each tick enqueues fresh jobs)', () => {
    const a = buildDemoFetchJobs('demo-portal', 2, '2026-07-01', 't1')
    const b = buildDemoFetchJobs('demo-portal', 2, '2026-07-01', 't2')
    expect(a.map(j => j.account)).not.toEqual(b.map(j => j.account))
  })
})

describe('producers no-op without Redis', () => {
  const saved = process.env.REDIS_URL
  afterEach(() => {
    vi.resetModules()
    if (saved === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = saved
  })
  it('return false and never touch the queue when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL
    const { enqueueEvent, enqueueFetch } = await import('../server/queue/producers')
    expect(await enqueueEvent({ memberId: 'M', domain: 'd', kind: 'ONAPPINSTALL', ts: '1' })).toBe(false)
    expect(await enqueueFetch({ memberId: 'M', providerId: 'manual', account: 'A', dateFrom: 'x', dateTo: 'y' })).toBe(false)
  })
})
