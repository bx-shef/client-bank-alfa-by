import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  handleCrmSyncJob, handleEventJob, handleFetchJob, handleParseJob, type HandlerDeps
} from '../server/queue/handlers'
import {
  DEMO_ACCOUNT_PREFIX, POLLABLE_PROVIDERS, accountsForPolling, buildDemoFetchJobs, cronIntervalMs,
  demoDelayMs, demoItems, demoTickMs, isDemoAccount, planFetches, pollWindow
} from '../server/queue/cron'
import type { CrmSyncJob, FetchJob } from '../server/queue/topology'
import type { ChatSettings, ChatTarget, PortalSettings, RecognitionSettings } from '../app/utils/settings'
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
  /** my-company id returned by findMyCompany (default null = my company not found either). */
  myCompany?: string | null
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
  /** error-chat target; default { dialogId: '' } (off). Set a dialogId to enable error notices. */
  errorChat?: ChatTarget
  /** what recordAllocation returns (true = fresh insert, false = already existed); default true. */
  recorded?: boolean
  /** autoDistribute gate (§2 mutation slice); default false (fact-only). */
  autoDistribute?: boolean
  /** allocation-mutation config (§2/#79), e.g. `{ invoicePaidStageId, triggerCode }`; default {}. */
  allocation?: { invoicePaidStageId?: string, triggerCode?: string }
  /** what hasAllocationFact returns (true = fact already exists → skip TRIGGER fire); default false. */
  factExists?: boolean
  /** what isTargetApplied returns (true = amount target already paid/settled in B24 → skip
   *  the amount mutation, Фаза A); default false. */
  alreadyApplied?: boolean
  /** what applyAllocation returns (true = portal write applied); default true. */
  applied?: boolean
  /** what applyTrigger returns (true = trigger fired); default true (#79). */
  triggerFired?: boolean
  /** what writeLedger returns (true = a new distribution row was created); default true (§9.1). */
  ledgerCreated?: boolean
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
  const errorChat = o.errorChat ?? { dialogId: '' }
  const settings: PortalSettings | null = chat === null ? null : { chat, errorChat, recognition, allocation: o.allocation ?? {}, autoDistribute: o.autoDistribute ?? false }
  const calls: Record<string, unknown[]> = { crm: [], activity: [], chat: [], del: [], save: [], find: [], findMy: [], activityNote: [], settings: [], recognized: [], resolve: [], resolvedLog: [], negStage: [], negStageSmart: [], allocLog: [], allocRec: [], errChat: [], unmatchedNotify: [], allocHas: [], allocApplied: [], allocApply: [], trigApply: [], ledger: [] }
  const negativeStage = o.negativeStage === undefined ? null : o.negativeStage
  const deps: HandlerDeps = {
    fetchStatement: async () => batch,
    parseFile: async () => batch,
    findCompany: async (it, memberId) => {
      calls.find.push([it.docId, memberId])
      return company
    },
    findMyCompany: async (it, memberId) => {
      calls.findMy.push([it.docId, memberId])
      return o.myCompany ?? null
    },
    writeActivity: async (it, companyId, memberId, note) => {
      if (!companyId) return null // no company → no owner → nothing written
      const id = `act-${nextId++}`
      // configurable.add stamps the ORIGINATOR_ID/ORIGIN_ID marker atomically with the
      // activity — model that by persisting the dedup key here (getActivityId reads it).
      written.set(`${it.account}|${it.docId}`, id)
      calls.activity.push([it.docId, companyId, memberId, id])
      calls.activityNote.push([it.docId, companyId, note ?? null]) // #91 reason-block capture
      return id
    },
    getPortalSettings: async (memberId) => {
      calls.settings.push(memberId)
      return settings
    },
    onRecognized: (it, intents: RecognitionIntent[], memberId) => {
      calls.recognized.push([it.docId, intents.map(i => `${i.kind}:${i.value}:${i.route.strategy}`), memberId])
    },
    resolveIntents: async (intents, companyId, memberId, isNegativeStage, configFields) => {
      calls.resolve.push([companyId, intents.map(i => i.kind), memberId, isNegativeStage ? 'staged' : 'unfiltered', configFields])
      return o.resolve ?? []
    },
    loadNegativeStagePredicate: async (memberId, smartEntityTypeId) => {
      calls.negStage.push(memberId)
      calls.negStageSmart.push(smartEntityTypeId ?? null)
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
    recordAllocation: async (it, target, memberId) => {
      calls.allocRec.push([it.docId, target.kind, target.id, memberId])
      return o.recorded ?? true
    },
    hasAllocationFact: async (it, target, memberId) => {
      calls.allocHas.push([it.docId, target.kind, target.id, memberId])
      return o.factExists ?? false
    },
    isTargetApplied: async (it, target, memberId, applyOpts) => {
      calls.allocApplied.push([it.docId, target.kind, target.id, memberId, applyOpts?.invoicePaidStageId])
      return o.alreadyApplied ?? false
    },
    applyAllocation: async (it, target, memberId, applyOpts) => {
      // Capture the 4th `opts` arg too — the invoice-stage mutation is driven by
      // `opts.invoicePaidStageId` reaching this dep from `settings.allocation`.
      calls.allocApply.push([it.docId, target.kind, target.id, memberId, applyOpts?.invoicePaidStageId])
      return o.applied ?? true
    },
    applyTrigger: async (it, target, memberId, code) => {
      // Capture entityTypeId too, so a handler-level smart-process test can prove the FULL
      // candidate (not a stripped {kind,id}) reaches applyTrigger — the #79 OWNER_TYPE_ID wire.
      calls.trigApply.push([it.docId, target.kind, target.id, memberId, code, target.entityTypeId])
      return o.triggerFired ?? true
    },
    writeLedger: async (it, target, companyId, memberId, etids) => {
      calls.ledger.push([it.docId, target.kind, target.id, companyId, memberId, etids.paymentSpEtid, etids.distributionSpEtid])
      return o.ledgerCreated ?? true
    },
    notifyError: async (it, decision, dialogId, memberId) => {
      calls.errChat.push([it.docId, decision.action, dialogId, memberId])
    },
    notifyUnmatched: async (it, dialogId, recordedToMyCompany, memberId) => {
      calls.unmatchedNotify.push([it.docId, recordedToMyCompany, dialogId, memberId])
    },
    getActivityId: async (_memberId, key) => written.get(key) ?? null,
    savePortal: async (job) => {
      calls.save.push(job.memberId)
    },
    deletePortal: async (m, eventTs) => {
      calls.del.push([m, eventTs])
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
    // deletePortal receives the parsed event ts (Number('1')||0 = 1) for the #77 tombstone.
    expect(calls.del).toEqual([['M', 1]])
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
  it('folds the poll epoch into batchId so a same-window re-poll re-runs crm-sync (A10)', async () => {
    const { deps, calls } = fakeDeps([item('d1')])
    await handleFetchJob({ ...fetchJob, epoch: 'tick42' }, deps)
    // Without epoch in batchId the crm-sync jobId would dedupe every same-day re-poll into a
    // no-op — the fetch re-runs but the B24-marker dedup never fires, dropping late-posted ops.
    expect((calls.crm[0] as CrmSyncJob).batchId).toBe('ACC:2026-07-01:2026-07-31:tick42')
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
    expect(r).toEqual({ processed: 2, created: 2, notified: 2, skipped: 0, excluded: 0, unmatched: 0, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, allocated: 0, distributed: 0, ledgerWritten: 0, credits: 1, debits: 1 })
    expect(calls.activity).toEqual([['d1', 'CO', 'M', 'act-1'], ['d2', 'CO', 'M', 'act-2']])
    // All three CRM ops receive the portal memberId ('M').
    expect(calls.find).toEqual([['d1', 'M'], ['d2', 'M']])
    expect(calls.chat).toEqual([['d1', 'M'], ['d2', 'M']])
  })

  it('is idempotent across job redelivery (round-trip through the B24 marker)', async () => {
    const { deps, calls } = fakeDeps() // the fake persists the marker across calls
    const j = job([item('d1'), item('d2')])
    const first = await handleCrmSyncJob(j, deps)
    expect(first).toMatchObject({ created: 2, notified: 2, skipped: 0, excluded: 0, unmatched: 0 })
    // Redeliver the SAME job: every op now carries a marker → all skipped, no side effects.
    const second = await handleCrmSyncJob(j, deps)
    expect(second).toEqual({ processed: 2, created: 0, notified: 0, skipped: 2, excluded: 0, unmatched: 0, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, allocated: 0, distributed: 0, ledgerWritten: 0, credits: 2, debits: 0 })
    expect(calls.activity).toHaveLength(2) // still just the first run's two writes
    expect(calls.chat).toHaveLength(2) // no re-notify on redelivery
    expect(calls.find).toHaveLength(2) // skipped ops don't even reach findCompany
  })

  it('skips ops already written (B24 marker dedup) — no re-write, no re-notify', async () => {
    const { deps, calls } = fakeDeps({ alreadyWritten: new Set(['A|d1']) })
    const r = await handleCrmSyncJob(job([item('d1'), item('d2')]), deps)
    expect(r).toEqual({ processed: 2, created: 1, notified: 1, skipped: 1, excluded: 0, unmatched: 0, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, allocated: 0, distributed: 0, ledgerWritten: 0, credits: 2, debits: 0 })
    // d1 was skipped BEFORE findCompany: only d2 hit findCompany/writeActivity/chat.
    expect(calls.find).toEqual([['d2', 'M']])
    expect(calls.chat).toEqual([['d2', 'M']])
    expect(calls.activity).toEqual([['d2', 'CO', 'M', 'act-1']])
  })

  it('counts unmatched ops (no company, no my-company) and does NOT remember or notify them', async () => {
    // errorChat off (default) → no notice; myCompany null (default) → nothing written.
    const { deps, calls } = fakeDeps({ company: null })
    const r = await handleCrmSyncJob(job([item('d1'), item('d2')]), deps)
    expect(r).toEqual({ processed: 2, created: 0, notified: 0, skipped: 0, excluded: 0, unmatched: 2, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, allocated: 0, distributed: 0, ledgerWritten: 0, credits: 2, debits: 0 })
    expect(calls.activity).toEqual([]) // nothing written → no marker → retried on redelivery
    expect(calls.chat).toEqual([])
    expect(calls.unmatchedNotify).toEqual([]) // error chat off → no notice
  })

  it('UNMATCHED client but MY company found → writes to my company with reason + error-chat notice (#91)', async () => {
    const { deps, calls } = fakeDeps({ company: null, myCompany: 'MY', errorChat: { dialogId: 'err' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit')]), deps)
    // Payment NOT lost: recorded (created:1) AND flagged unmatched (payer unknown).
    expect(r).toMatchObject({ processed: 1, created: 1, unmatched: 1, notified: 0 })
    // Written to MY company (not a client), carrying the reason note.
    expect(calls.activity).toEqual([['d1', 'MY', 'M', 'act-1']])
    const note = (calls.activityNote as [string, string, string | null][])[0]
    expect(note[1]).toBe('MY')
    expect(note[2]).toContain('Клиент не определён')
    // Reported to the ERROR chat (recorded=true), and NOT to the normal chat.
    expect(calls.unmatchedNotify).toEqual([['d1', true, 'err', 'M']])
    expect(calls.chat).toEqual([])
  })

  it('UNMATCHED client AND no MY company → nothing written, error-chat notice recorded=false (§5)', async () => {
    const { deps, calls } = fakeDeps({ company: null, myCompany: null, errorChat: { dialogId: 'err' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit')]), deps)
    expect(r).toMatchObject({ created: 0, unmatched: 1 })
    expect(calls.activity).toEqual([]) // nothing written (no owner) → retried once requisites exist
    expect(calls.unmatchedNotify).toEqual([['d1', false, 'err', 'M']])
  })

  it('matched-client op is NOT reported to the error chat as unmatched (and carries no reason note)', async () => {
    const { deps, calls } = fakeDeps({ company: 'CO', myCompany: 'MY', errorChat: { dialogId: 'err' } })
    await handleCrmSyncJob(job([item('d1', 'credit')]), deps)
    expect(calls.activity).toEqual([['d1', 'CO', 'M', 'act-1']]) // to the CLIENT, not my company
    expect(calls.findMy).toEqual([]) // my-company lookup not even attempted when client matched
    expect(calls.unmatchedNotify).toEqual([])
    expect((calls.activityNote as [string, string, string | null][])[0]![2]).toBeNull() // no note on the client write
  })

  it('my-company fallback WRITE + a normal client create in ONE batch — both write, counters do not leak (#91)', async () => {
    const { deps, calls } = fakeDeps({ myCompany: 'MY', errorChat: { dialogId: 'err' } })
    deps.findCompany = async it => (it.docId === 'd1' ? 'CO' : null) // d1 client found, d2 unmatched
    const r = await handleCrmSyncJob(job([item('d1', 'credit'), item('d2', 'credit')]), deps)
    expect(r).toMatchObject({ processed: 2, created: 2, unmatched: 1, notified: 1, credits: 2 })
    expect(calls.activity).toEqual([['d1', 'CO', 'M', 'act-1'], ['d2', 'MY', 'M', 'act-2']])
    expect(calls.unmatchedNotify).toEqual([['d2', true, 'err', 'M']]) // only the fallback op
    expect(calls.chat).toEqual([['d1', 'M']]) // only the matched client op reaches the normal chat
  })

  it('redelivery of a my-company fallback op → dedup-skipped: no re-write, no re-notify, no re-lookup (#91 «не долбит REST»)', async () => {
    const { deps, calls } = fakeDeps({ company: null, myCompany: 'MY', errorChat: { dialogId: 'err' } })
    const j = job([item('d1', 'credit')])
    const first = await handleCrmSyncJob(j, deps)
    expect(first).toMatchObject({ created: 1, unmatched: 1, credits: 1 })
    const second = await handleCrmSyncJob(j, deps) // redelivery — marker now in B24
    expect(second).toMatchObject({ processed: 1, created: 0, skipped: 1, unmatched: 0 })
    expect(calls.activity).toHaveLength(1) // written once, not twice
    expect(calls.unmatchedNotify).toHaveLength(1) // notified once
    expect(calls.findMy).toHaveLength(1) // my-company looked up once — dedup skip precedes it
  })

  it('a pre-written unmatched op is dedup-skipped BEFORE findMy / notifyUnmatched fire', async () => {
    const { deps, calls } = fakeDeps({ company: null, myCompany: 'MY', errorChat: { dialogId: 'err' }, alreadyWritten: new Set(['A|d1']) })
    const r = await handleCrmSyncJob(job([item('d1', 'credit')]), deps)
    expect(r).toMatchObject({ skipped: 1, created: 0, unmatched: 0 })
    expect(calls.findMy).toEqual([])
    expect(calls.unmatchedNotify).toEqual([])
  })

  it('my company found but error chat OFF → writes to my company, sends NO notice', async () => {
    const { deps, calls } = fakeDeps({ company: null, myCompany: 'MY' }) // errorChat default off
    const r = await handleCrmSyncJob(job([item('d1', 'credit')]), deps)
    expect(r).toMatchObject({ created: 1, unmatched: 1 })
    expect(calls.activity).toEqual([['d1', 'MY', 'M', 'act-1']])
    expect(calls.unmatchedNotify).toEqual([]) // notice gated by errorChat.dialogId
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
    expect(r).toEqual({ processed: 3, created: 1, notified: 1, skipped: 1, excluded: 0, unmatched: 1, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, allocated: 0, distributed: 0, ledgerWritten: 0, credits: 2, debits: 1 })
    expect(calls.activity).toEqual([['d2', 'CO', 'M', 'act-1']])
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
    expect(r).toMatchObject({ created: 1, notified: 0 }) // written, but NOT notified (no target)
    expect(calls.chat).toEqual([]) // written, but not announced
  })

  it('no announcement when chat settings are null (unavailable)', async () => {
    const { deps, calls } = fakeDeps({ chat: null })
    await handleCrmSyncJob(job([item('d1', 'credit')]), deps)
    expect(calls.chat).toEqual([])
  })

  it('direction rule gates ONLY the announcement, not the write (расход пишется, не оповещается)', async () => {
    // directions: credits only → a created DEBIT is written but not announced.
    const dir = fakeDeps({ chat: { dialogId: 'c', rules: { directions: ['credit'] } } })
    const dr = await handleCrmSyncJob(job([item('d1', 'credit'), item('d2', 'debit')]), dir.deps)
    // both written, ONLY the credit announced → notified (1) ≠ created (2). Pins that
    // `notified++` lives in the notify branch, not alongside `created++`.
    expect(dr).toMatchObject({ created: 2, notified: 1 })
    expect(dir.calls.chat).toEqual([['d1', 'M']])
  })

  it('excluded account → op skipped ENTIRELY: no company lookup, no activity, no chat (PROCESSING §2 A2)', async () => {
    // item.account = 'A' (see item()); excludeAccounts:['A'] must skip the whole op.
    const acc = fakeDeps({ chat: { dialogId: 'c', rules: { directions: ['credit'], excludeAccounts: ['A'] } } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit')]), acc.deps)
    // Full shape: only `excluded` and the приход/расход split move; nothing produced.
    expect(r).toEqual({ processed: 1, created: 0, notified: 0, skipped: 0, excluded: 1, unmatched: 0, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, allocated: 0, distributed: 0, ledgerWritten: 0, credits: 1, debits: 0 })
    expect(acc.calls.find).toEqual([]) // never even looked up the company
    expect(acc.calls.activity).toEqual([]) // NO CRM activity written
    expect(acc.calls.chat).toEqual([]) // NO chat
  })

  it('excluded purpose substring → op skipped entirely (no activity, counted excluded)', async () => {
    // item.purpose = 'p' (see item()); excludePurposePatterns:['p'] must skip the whole op.
    const pur = fakeDeps({ chat: { dialogId: 'c', rules: { directions: ['credit'], excludePurposePatterns: ['p'] } } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit')]), pur.deps)
    expect(r).toEqual({ processed: 1, created: 0, notified: 0, skipped: 0, excluded: 1, unmatched: 0, recognized: 0, resolved: 0, allocatable: 0, ambiguous: 0, manual: 0, allocated: 0, distributed: 0, ledgerWritten: 0, credits: 1, debits: 0 })
    expect(pur.calls.activity).toEqual([])
    expect(pur.calls.chat).toEqual([])
  })

  it('mixed batch: excluded op skipped while a non-excluded op in the SAME batch processes normally', async () => {
    // Exclude only d1's account. d1.account='A' (excluded); override d2 to a different account.
    const mix = fakeDeps({ chat: { dialogId: 'c', rules: { directions: ['credit'], excludeAccounts: ['A'] } } })
    const d1 = item('d1', 'credit') // account 'A' → excluded
    const d2 = { ...item('d2', 'credit'), account: 'B' } // account 'B' → processed
    const r = await handleCrmSyncJob(job([d1, d2]), mix.deps)
    expect(r).toMatchObject({ processed: 2, created: 1, excluded: 1, unmatched: 0 })
    // Only the non-excluded op reached company lookup / activity / chat.
    expect(mix.calls.find).toEqual([['d2', 'M']])
    expect(mix.calls.activity).toEqual([['d2', 'CO', 'M', 'act-1']])
    expect(mix.calls.chat).toEqual([['d2', 'M']])
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
    expect(calls.resolve).toEqual([['CO', ['invoice-number'], 'M', 'unfiltered', {}]]) // companyId + intent kinds + (no predicate → unfiltered) + configFields (default {})
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
    expect(calls.negStageSmart).toEqual([null]) // no smart-entity configured → null forwarded
  })

  // Handler→loader wiring (#109 SP negative-stage slice): the configured smart-process
  // entityTypeId (configFields['smart-entity'], parsed) must reach loadNegativeStagePredicate
  // so the predicate can also exclude a lost SP element. Pins the parse+forward seam.
  it('forwards the parsed smart-entity entityTypeId into loadNegativeStagePredicate', async () => {
    const withSmart: RecognitionSettings = {
      alphabet: 'cyrillic', configFields: { 'smart-entity': '1032' },
      matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' }]
    }
    const { deps, calls } = fakeDeps({ recognition: withSmart, resolve: hit, negativeStage: () => false })
    await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(calls.negStageSmart).toEqual([1032]) // parsed to a positive int and forwarded
  })

  it('forwards null when smart-entity is blank/non-numeric (fail-closed, SP not loaded)', async () => {
    const badSmart: RecognitionSettings = {
      alphabet: 'cyrillic', configFields: { 'smart-entity': 'abc' },
      matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' }]
    }
    const { deps, calls } = fakeDeps({ recognition: badSmart, resolve: hit, negativeStage: () => false })
    await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(calls.negStageSmart).toEqual([null])
  })

  // §4 by-config-field: the portal's configFields map must reach resolveIntents so the
  // deal-field lookup knows which CRM field to search (handler→worker plumbing).
  it('threads the portal configFields into resolveIntents (deal-field lookup, §4)', async () => {
    const withField: RecognitionSettings = {
      alphabet: 'cyrillic', matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' }],
      configFields: { 'deal-field': 'UF_CRM_PAY_NO' }
    }
    const { deps, calls } = fakeDeps({ recognition: withField, resolve: hit })
    await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect((calls.resolve[0] as unknown[])[4]).toEqual({ 'deal-field': 'UF_CRM_PAY_NO' }) // forwarded verbatim
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
  })

  // Allocation WRITE slice (#184): a decided `allocate` records a write-once fact
  // (payment→target), and an ambiguous/manual outcome posts a notice to the error chat.
  it('records the allocation fact for a decided allocate and counts it', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: [invAt('7', 10)] })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r.allocated).toBe(1)
    expect(calls.allocRec).toEqual([['d1', 'invoice', '7', 'M']]) // target kind + id
  })

  it('does not double-count the fact when it already existed (redelivery, write-once)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: [invAt('7', 10)], recorded: false })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r.allocated).toBe(0) // store reported "already existed"
    expect(calls.allocRec).toHaveLength(1) // but still attempted
  })

  it('records the smallest-id target AND posts a heads-up on an ambiguous allocation', async () => {
    const two: IntentResolution[] = [{
      kind: 'invoice-number', value: 'СЧ-0001', status: 'resolved',
      candidates: [{ kind: 'invoice', id: '9', amount: 10, currency: 'BYN' }, { kind: 'invoice', id: '5', amount: 10, currency: 'BYN' }]
    }]
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: two, errorChat: { dialogId: 'errchat' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ ambiguous: 1, allocated: 1 })
    expect(calls.allocRec).toEqual([['d1', 'invoice', '5', 'M']]) // smallest id recorded
    expect(calls.errChat).toEqual([['d1', 'allocate', 'errchat', 'M']]) // ambiguous decision is action=allocate
  })

  it('posts a manual allocation notice to the error chat and records no fact', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: [invAt('7', 100)], errorChat: { dialogId: 'errchat' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r).toMatchObject({ manual: 1, allocated: 0 })
    expect(calls.allocRec).toEqual([]) // no allocate → no fact
    expect(calls.errChat).toEqual([['d1', 'manual', 'errchat', 'M']])
  })

  it('does not post an error notice when no error chat is configured (default off)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: [invAt('7', 100)] }) // manual outcome
    await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(calls.errChat).toEqual([]) // errorChat.dialogId '' → off
  })

  it('does NOT re-post the error notice on a job redelivery (notice sits after the dedup marker)', async () => {
    // The error notice is emitted AFTER writeActivity stamps the marker (im.message.add has no
    // dedup). A redelivered job (same op, marker already in B24) is skipped at the top gate before
    // reaching the notice — so a job-level retry (more frequent with SDK in-client retry off, #123)
    // can't double-post. Run the SAME job twice through the SAME deps (shared marker store).
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: [invAt('7', 100)], errorChat: { dialogId: 'errchat' } })
    const j = job([item('d1', 'credit', 'счет СЧ-0001')])
    await handleCrmSyncJob(j, deps) // first run: manual outcome → one notice + marker written
    expect(calls.errChat).toEqual([['d1', 'manual', 'errchat', 'M']])
    const r2 = await handleCrmSyncJob(j, deps) // redelivery: getActivityId finds the marker → op skipped
    expect(r2).toMatchObject({ skipped: 1 })
    expect(calls.errChat).toEqual([['d1', 'manual', 'errchat', 'M']]) // STILL one — not re-posted
  })

  it('records a clean single-target allocate WITHOUT an error notice', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: [invAt('7', 10)], errorChat: { dialogId: 'errchat' } })
    await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(calls.allocRec).toEqual([['d1', 'invoice', '7', 'M']])
    expect(calls.errChat).toEqual([]) // clean allocate → no heads-up
  })

  it('a trigger-only allocatable op records no fact and posts no notice (v1: amount-target facts only)', async () => {
    const dealMatrix: RecognitionSettings = { alphabet: 'cyrillic', configFields: {}, matrices: [{ mask: 'Д-dd', kind: 'deal-id' }] }
    const trig: IntentResolution[] = [{ kind: 'deal-id', value: '55', status: 'resolved', candidates: [{ kind: 'deal', id: '3', amount: 0, currency: '' }] }]
    const { deps, calls } = fakeDeps({ recognition: dealMatrix, resolve: trig, errorChat: { dialogId: 'errchat' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'сделка Д-55')]), deps)
    expect(r).toMatchObject({ allocatable: 1, allocated: 0 })
    expect(calls.allocRec).toEqual([]) // decision.action='none' (trigger only) → no amount-fact
    expect(calls.errChat).toEqual([]) // allocatable (not ambiguous/manual) → no notice
  })

  it('accumulates `allocated` across a batch, counting only fresh inserts (write-once)', async () => {
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix })
    deps.resolveIntents = async () => [invAt('7', 10)] // every op → exact allocate
    let n = 0
    // first op inserts a fresh fact (true), second already existed (false).
    deps.recordAllocation = async (it, target) => {
      calls.allocRec.push([it.docId, target.kind, target.id, 'M'])
      return n++ === 0
    }
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001'), item('d2', 'credit', 'счет СЧ-0002')]), deps)
    expect(r.allocated).toBe(1) // only the fresh insert counted
    expect(calls.allocRec).toHaveLength(2) // both attempted
  })

  // Mutation slice (§2, #109): the `autoDistribute` gate marks a deal-payment target paid.
  const payMatrix: RecognitionSettings = {
    alphabet: 'cyrillic', configFields: {}, matrices: [{ mask: 'ОП-dddd', kind: 'payment-number' }]
  }
  // deal-payment candidate matching the op amount (10 BYN) → exact allocate.
  const payAt = (id: string): IntentResolution => ({
    kind: 'payment-number', value: 'ОП-0001', status: 'resolved',
    candidates: [{ kind: 'deal-payment', id, amount: 10, currency: 'BYN' }]
  })

  it('autoDistribute OFF (default): records the fact but performs NO portal mutation', async () => {
    const { deps, calls } = fakeDeps({ recognition: payMatrix, resolve: [payAt('42')] })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата ОП-0001')]), deps)
    expect(r.allocated).toBe(1)
    expect(r.distributed).toBe(0)
    expect(calls.allocRec).toEqual([['d1', 'deal-payment', '42', 'M']]) // fact recorded
    expect(calls.allocApply).toEqual([]) // no mutation
    expect(calls.allocApplied).toEqual([]) // amount pre-check only runs when gate is on
  })

  it('autoDistribute ON: pays the deal-payment then records the fact (distributed counted)', async () => {
    const { deps, calls } = fakeDeps({ recognition: payMatrix, resolve: [payAt('42')], autoDistribute: true })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата ОП-0001')]), deps)
    expect(r.allocated).toBe(1)
    expect(r.distributed).toBe(1)
    expect(calls.allocApplied).toEqual([['d1', 'deal-payment', '42', 'M', undefined]]) // B24-state pre-check (Фаза A)
    expect(calls.allocApply).toEqual([['d1', 'deal-payment', '42', 'M', undefined]]) // portal mutation applied
    expect(calls.allocRec).toEqual([['d1', 'deal-payment', '42', 'M']]) // fact recorded AFTER
  })

  it('autoDistribute ON but target already applied in B24: skips re-pay, still records the write-once fact (Фаза A reconcile)', async () => {
    // Crash-window reconcile: a prior run paid but may have crashed before the fact. isTargetApplied
    // reads paid=Y → skip the pay, but STILL record the write-once fact (accounting/reversal) — a
    // fresh insert here bumps `allocated` (not `distributed`, since nothing was applied THIS run).
    const { deps, calls } = fakeDeps({ recognition: payMatrix, resolve: [payAt('42')], autoDistribute: true, alreadyApplied: true })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата ОП-0001')]), deps)
    expect(r.distributed).toBe(0) // nothing paid this run
    expect(r.allocated).toBe(1) // fact recorded (durable audit/reversal record)
    expect(calls.allocApplied).toEqual([['d1', 'deal-payment', '42', 'M', undefined]]) // B24 state checked
    expect(calls.allocApply).toEqual([]) // never re-paid
    expect(calls.allocRec).toEqual([['d1', 'deal-payment', '42', 'M']]) // write-once fact recorded
  })

  it('autoDistribute ON, already applied AND fact already exists: fully idempotent (no counters bump)', async () => {
    // Normal redelivery where the fact was already written: recordAllocation returns false → nothing
    // double-counts, no re-pay. (The activity marker usually `continue`s this earlier; this pins the
    // allocation-block idempotency directly.)
    const { deps, calls } = fakeDeps({ recognition: payMatrix, resolve: [payAt('42')], autoDistribute: true, alreadyApplied: true, recorded: false })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата ОП-0001')]), deps)
    expect(r.allocated).toBe(0)
    expect(r.distributed).toBe(0)
    expect(calls.allocApply).toEqual([]) // never re-paid
    expect(calls.allocRec).toHaveLength(1) // record attempted (write-once), returned false
  })

  it('autoDistribute ON, unsupported target (applied=false): records fact, distributed not bumped', async () => {
    // Real worker returns applied=false for a non-deal-payment target (e.g. invoice stage
    // w/o config); the fact is still recorded so it is not re-attempted.
    const { deps, calls } = fakeDeps({ recognition: invoiceMatrix, resolve: [invAt('7', 10)], autoDistribute: true, applied: false })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r.allocated).toBe(1)
    expect(r.distributed).toBe(0)
    expect(calls.allocApply).toEqual([['d1', 'invoice', '7', 'M', undefined]]) // attempted
    expect(calls.allocRec).toEqual([['d1', 'invoice', '7', 'M']]) // fact still recorded
  })

  it('autoDistribute ON, portal mutation throws: no fact recorded (clean retry)', async () => {
    const { deps, calls } = fakeDeps({ recognition: payMatrix, resolve: [payAt('42')], autoDistribute: true })
    deps.applyAllocation = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(handleCrmSyncJob(job([item('d1', 'credit', 'оплата ОП-0001')]), deps)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
    expect(calls.allocRec).toEqual([]) // mutation ran BEFORE the fact → nothing persisted
  })

  it('autoDistribute ON, mutation applied but fact insert lost the race (recorded=false): counters stay 0', async () => {
    // Narrow TOCTOU: isTargetApplied saw not-applied, applyAllocation paid, but recordAllocation
    // reported the row already existed (a concurrent job won). Neither counter bumps even
    // though a portal write happened — pins the `if (recordAllocation) { …; if (applied) }` nesting.
    const { deps, calls } = fakeDeps({ recognition: payMatrix, resolve: [payAt('42')], autoDistribute: true, recorded: false })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата ОП-0001')]), deps)
    expect(r.allocated).toBe(0)
    expect(r.distributed).toBe(0)
    expect(calls.allocApply).toEqual([['d1', 'deal-payment', '42', 'M', undefined]]) // mutation still attempted
    expect(calls.allocRec).toHaveLength(1) // record attempted, returned false
  })

  it('autoDistribute ON, mixed batch: distributed is a strict subset of allocated', async () => {
    // d1 → deal-payment (applied true → distributed), d2 → invoice (unsupported → applied false).
    const bothMatrices: RecognitionSettings = {
      alphabet: 'cyrillic', configFields: {}, matrices: [{ mask: 'ОП-dddd', kind: 'payment-number' }, { mask: 'СЧ-dddd', kind: 'invoice-number' }]
    }
    const { deps, calls } = fakeDeps({ recognition: bothMatrices, autoDistribute: true })
    // applyAllocation mirrors the real worker: deal-payment pays; invoice w/o a configured
    // stage is unsupported (opts.invoicePaidStageId is undefined here → no invoice mutation).
    deps.applyAllocation = async (it, target, memberId, applyOpts) => {
      calls.allocApply.push([it.docId, target.kind, target.id, memberId, applyOpts?.invoicePaidStageId])
      return target.kind === 'deal-payment'
    }
    deps.resolveIntents = async intents => (intents[0]?.kind === 'payment-number' ? [payAt('42')] : [invAt('7', 10)])
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата ОП-0001'), item('d2', 'credit', 'счет СЧ-0001')]), deps)
    expect(r.allocated).toBe(2) // both facts recorded
    expect(r.distributed).toBe(1) // only the deal-payment actually paid (subset of allocated)
    expect(calls.allocApply).toEqual([['d1', 'deal-payment', '42', 'M', undefined], ['d2', 'invoice', '7', 'M', undefined]])
  })

  it('autoDistribute ON + configured invoice stage: the stage reaches applyAllocation opts and the invoice is distributed', async () => {
    // The invoice-stage mutation is armed by settings.allocation.invoicePaidStageId — assert it
    // threads through to applyAllocation, and that a supported invoice write bumps `distributed`.
    const { deps, calls } = fakeDeps({
      recognition: invoiceMatrix, resolve: [invAt('7', 10)], autoDistribute: true,
      allocation: { invoicePaidStageId: 'DT31_11:P' }
    })
    // Mirror the real worker: with a configured stage, the invoice mutation IS applied.
    deps.applyAllocation = async (it, target, memberId, applyOpts) => {
      calls.allocApply.push([it.docId, target.kind, target.id, memberId, applyOpts?.invoicePaidStageId])
      return target.kind === 'invoice' && !!applyOpts?.invoicePaidStageId
    }
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0001')]), deps)
    expect(r.allocated).toBe(1)
    expect(r.distributed).toBe(1) // configured stage → invoice write applied
    expect(calls.allocApply).toEqual([['d1', 'invoice', '7', 'M', 'DT31_11:P']]) // stage threaded through
  })

  // Trigger slice (#79): a deal trigger target fires the portal automation trigger.
  const dealMatrix: RecognitionSettings = {
    alphabet: 'cyrillic', configFields: {}, matrices: [{ mask: 'Д-dd', kind: 'deal-id' }]
  }
  const dealAt = (id: string): IntentResolution => ({
    kind: 'deal-id', value: 'Д-55', status: 'resolved',
    candidates: [{ kind: 'deal', id, amount: 0, currency: 'BYN' }]
  })

  it('autoDistribute ON + triggerCode: fires the deal trigger, records the fact, distributed counted (#79)', async () => {
    const { deps, calls } = fakeDeps({ recognition: dealMatrix, resolve: [dealAt('77')], autoDistribute: true, allocation: { triggerCode: 'cbatest_pay' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата Д-55')]), deps)
    expect(r.allocated).toBe(1)
    expect(r.distributed).toBe(1)
    expect(calls.allocHas).toEqual([['d1', 'deal', '77', 'M']]) // idempotency pre-check
    expect(calls.trigApply).toEqual([['d1', 'deal', '77', 'M', 'cbatest_pay', undefined]]) // fired with the CODE
    expect(calls.allocRec).toEqual([['d1', 'deal', '77', 'M']]) // fact recorded AFTER
  })

  it('autoDistribute ON + triggerCode: a SMART-PROCESS target reaches applyTrigger WITH its entityTypeId (#79 wire)', async () => {
    // Pins the handler→applyTrigger join for smart-process: the full candidate (incl.
    // entityTypeId, needed as OWNER_TYPE_ID) must reach applyTrigger, not a stripped {kind,id}.
    const smartMatrix: RecognitionSettings = {
      alphabet: 'cyrillic', configFields: { 'smart-entity': '1032' }, matrices: [{ mask: 'СП-dd', kind: 'smart-id' }]
    }
    const smartAt: IntentResolution = {
      kind: 'smart-id', value: 'СП-90', status: 'resolved',
      candidates: [{ kind: 'smart-process', id: '9', amount: 0, currency: 'BYN', entityTypeId: 1032 }]
    }
    const { deps, calls } = fakeDeps({ recognition: smartMatrix, resolve: [smartAt], autoDistribute: true, allocation: { triggerCode: 'cbatest_pay' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата СП-90')]), deps)
    expect(r.distributed).toBe(1)
    // entityTypeId 1032 is the 6th element — proves the full candidate survived to applyTrigger.
    expect(calls.trigApply).toEqual([['d1', 'smart-process', '9', 'M', 'cbatest_pay', 1032]])
    expect(calls.allocRec).toEqual([['d1', 'smart-process', '9', 'M']])
  })

  it('autoDistribute ON but NO triggerCode configured: does NOT fire the trigger (#79)', async () => {
    const { deps, calls } = fakeDeps({ recognition: dealMatrix, resolve: [dealAt('77')], autoDistribute: true })
    await handleCrmSyncJob(job([item('d1', 'credit', 'оплата Д-55')]), deps)
    expect(calls.trigApply).toEqual([])
  })

  it('autoDistribute OFF + triggerCode set: does NOT fire the trigger (opt-in gate) (#79)', async () => {
    const { deps, calls } = fakeDeps({ recognition: dealMatrix, resolve: [dealAt('77')], allocation: { triggerCode: 'cbatest_pay' } })
    await handleCrmSyncJob(job([item('d1', 'credit', 'оплата Д-55')]), deps)
    expect(calls.trigApply).toEqual([])
  })

  it('autoDistribute ON + triggerCode, fact already exists: skips re-fire AND re-record (idempotent) (#79)', async () => {
    const { deps, calls } = fakeDeps({ recognition: dealMatrix, resolve: [dealAt('77')], autoDistribute: true, allocation: { triggerCode: 'cbatest_pay' }, factExists: true })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата Д-55')]), deps)
    expect(r.distributed).toBe(0)
    expect(calls.trigApply).toEqual([]) // never re-fired
    expect(calls.allocRec).toEqual([]) // never re-recorded
  })

  it('autoDistribute ON + triggerCode, two intents → SAME deal: fires ONCE (distinct dedup) (#79)', async () => {
    const twoToSameDeal: IntentResolution[] = [
      { kind: 'deal-id', value: 'Д-55', status: 'resolved', candidates: [{ kind: 'deal', id: '77', amount: 0, currency: 'BYN' }] },
      { kind: 'deal-id', value: 'Д-55', status: 'resolved', candidates: [{ kind: 'deal', id: '77', amount: 0, currency: 'BYN' }] }
    ]
    const { deps, calls } = fakeDeps({ recognition: dealMatrix, resolve: twoToSameDeal, autoDistribute: true, allocation: { triggerCode: 'cbatest_pay' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата Д-55')]), deps)
    expect(r.distributed).toBe(1)
    expect(calls.trigApply).toEqual([['d1', 'deal', '77', 'M', 'cbatest_pay', undefined]]) // deduped → one fire
  })

  it('autoDistribute ON + triggerCode, applyTrigger returned false (un-fired): NO fact, job still succeeds (single-shot) (#79)', async () => {
    // NB: the never-THROW guarantee lives in the worker dep (worker.ts wraps applyTrigger in
    // try/catch → false); the handler awaits applyTrigger without a catch and relies on that
    // contract. Here we exercise the un-fired (returned-false) path: no fact is written, and the
    // job as a whole still completes (a non-fire does not fail the batch). SINGLE-SHOT: the B24
    // dedup marker (writeActivity) is still written this run, so this op is NOT re-attempted on a
    // later poll — a swallowed miss is lost, not self-healed (durable retry is a follow-up).
    const { deps, calls } = fakeDeps({ recognition: dealMatrix, resolve: [dealAt('77')], autoDistribute: true, allocation: { triggerCode: 'cbatest_pay' }, triggerFired: false })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата Д-55')]), deps)
    expect(r.allocated).toBe(0) // no fire → no fact
    expect(r.distributed).toBe(0)
    expect(r.created).toBe(1) // job still succeeds — an un-fired trigger does not fail the batch
    expect(calls.trigApply).toEqual([['d1', 'deal', '77', 'M', 'cbatest_pay', undefined]]) // attempted once
    expect(calls.allocRec).toEqual([]) // no fact persisted (but the activity marker IS written → single-shot)
  })

  it('autoDistribute ON + triggerCode, fired but recordAllocation lost the race (recorded=false): counters stay 0 (#79)', async () => {
    // TOCTOU on the trigger path: hasAllocationFact saw none, the trigger FIRED, but the write-once
    // fact insert reported the row already existed (a concurrent job won). Neither counter bumps.
    const { deps, calls } = fakeDeps({ recognition: dealMatrix, resolve: [dealAt('77')], autoDistribute: true, allocation: { triggerCode: 'cbatest_pay' }, recorded: false })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата Д-55')]), deps)
    expect(r.allocated).toBe(0)
    expect(r.distributed).toBe(0)
    expect(calls.trigApply).toEqual([['d1', 'deal', '77', 'M', 'cbatest_pay', undefined]]) // fired
    expect(calls.allocRec).toHaveLength(1) // record attempted, returned false
  })

  it('autoDistribute ON + triggerCode, two DISTINCT deals: fires the trigger for EACH (#79)', async () => {
    const twoDeals: IntentResolution[] = [
      { kind: 'deal-id', value: 'Д-55', status: 'resolved', candidates: [{ kind: 'deal', id: '77', amount: 0, currency: 'BYN' }] },
      { kind: 'deal-id', value: 'Д-56', status: 'resolved', candidates: [{ kind: 'deal', id: '88', amount: 0, currency: 'BYN' }] }
    ]
    const { deps, calls } = fakeDeps({ recognition: dealMatrix, resolve: twoDeals, autoDistribute: true, allocation: { triggerCode: 'cbatest_pay' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата Д-55 Д-56')]), deps)
    expect(r.distributed).toBe(2) // distinct kind:id → the loop iterates and fires each
    expect(calls.trigApply).toEqual([['d1', 'deal', '77', 'M', 'cbatest_pay', undefined], ['d1', 'deal', '88', 'M', 'cbatest_pay', undefined]])
    expect(calls.allocRec).toEqual([['d1', 'deal', '77', 'M'], ['d1', 'deal', '88', 'M']])
  })

  it('autoDistribute ON + triggerCode, ONE op resolves to BOTH an amount invoice AND a deal trigger: both fire, both counted (#79)', async () => {
    // The amount `allocate` block and the trigger block are independent: an op can carry an
    // amount target (invoice, exact-match → applyAllocation) AND a trigger target (deal →
    // applyTrigger). Both write a fact (distinct kinds → no fact-key collision) and both bump.
    const mixMatrix: RecognitionSettings = {
      alphabet: 'cyrillic', configFields: {},
      matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' }, { mask: 'Д-dd', kind: 'deal-id' }]
    }
    const { deps, calls } = fakeDeps({
      recognition: mixMatrix, autoDistribute: true, allocation: { triggerCode: 'cbatest_pay', invoicePaidStageId: 'DT31_11:P' }
    })
    deps.resolveIntents = async () => [invAt('7', 10), dealAt('77')]
    deps.applyAllocation = async (it, target, memberId, applyOpts) => {
      calls.allocApply.push([it.docId, target.kind, target.id, memberId, applyOpts?.invoicePaidStageId])
      return target.kind === 'invoice' && !!applyOpts?.invoicePaidStageId
    }
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счет СЧ-0007 оплата Д-55')]), deps)
    expect(r.allocated).toBe(2) // invoice fact + deal-trigger fact
    expect(r.distributed).toBe(2) // invoice mutation applied + deal trigger fired
    expect(calls.allocApply).toEqual([['d1', 'invoice', '7', 'M', 'DT31_11:P']]) // amount path
    expect(calls.trigApply).toEqual([['d1', 'deal', '77', 'M', 'cbatest_pay', undefined]]) // trigger path
    expect(calls.allocRec).toEqual([['d1', 'invoice', '7', 'M'], ['d1', 'deal', '77', 'M']]) // both facts
  })

  it('autoDistribute ON + ambiguous deal-payment: pays the smallest-id target AND posts the heads-up', async () => {
    const two: IntentResolution[] = [{
      kind: 'payment-number', value: 'ОП-0001', status: 'resolved',
      candidates: [{ kind: 'deal-payment', id: '9', amount: 10, currency: 'BYN' }, { kind: 'deal-payment', id: '5', amount: 10, currency: 'BYN' }]
    }]
    const { deps, calls } = fakeDeps({ recognition: payMatrix, resolve: two, autoDistribute: true, errorChat: { dialogId: 'errchat' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'оплата ОП-0001')]), deps)
    expect(r).toMatchObject({ ambiguous: 1, allocated: 1, distributed: 1 })
    expect(calls.allocApply).toEqual([['d1', 'deal-payment', '5', 'M', undefined]]) // smallest id paid
    expect(calls.errChat).toEqual([['d1', 'allocate', 'errchat', 'M']]) // ambiguous still notifies
  })
})

describe('handleCrmSyncJob — SP-ledger write at allocate (§9.1)', () => {
  const job = (items: StatementItem[]): CrmSyncJob => ({ memberId: 'M', providerId: 'alfa-by', source: 'fetch', batchId: 'b', items })
  const invMatrix: RecognitionSettings = { alphabet: 'cyrillic', configFields: {}, matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' }] }
  // recognition WITH both SP ids provisioned in configFields → carrier = smart-process.
  const provisioned: RecognitionSettings = { ...invMatrix, configFields: { 'payment-sp': '1044', 'distribution-sp': '1046' } }
  const invAt = (id: string, amount: number): IntentResolution => ({
    kind: 'invoice-number', value: 'СЧ-0007', status: 'resolved', candidates: [{ kind: 'invoice', id, amount, currency: 'BYN' }]
  })

  it('autoDistribute ON + SP provisioned + exact match → writes the ledger (ledgerWritten bumps)', async () => {
    const { deps, calls } = fakeDeps({ recognition: provisioned, resolve: [invAt('7', 10)], autoDistribute: true, allocation: { invoicePaidStageId: 'DT31_11:P' } })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счёт СЧ-0007')]), deps)
    expect(r.ledgerWritten).toBe(1)
    expect(calls.ledger).toEqual([['d1', 'invoice', '7', 'CO', 'M', 1044, 1046]]) // company + both etids threaded
    expect(calls.allocApply).toHaveLength(1) // ledger write must NOT suppress the gated portal mutation
  })

  it('autoDistribute OFF but SP provisioned → ledger IS written (dedup fact), portal mutation is NOT applied (§9.3 #6)', async () => {
    const { deps, calls } = fakeDeps({ recognition: provisioned, resolve: [invAt('7', 10)], autoDistribute: false })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счёт СЧ-0007')]), deps)
    // The distribution-fact record (ledger row) is decoupled from the autoDistribute gate: it is
    // written whenever the SP-ledger is provisioned. Only the portal mutation stays gated OFF.
    expect(r.ledgerWritten).toBe(1)
    expect(calls.ledger).toEqual([['d1', 'invoice', '7', 'CO', 'M', 1044, 1046]])
    expect(calls.allocApply).toEqual([]) // applyAllocation (payment.pay / invoice stage) NOT called
  })

  it('SP NOT provisioned (no configFields) → no ledger write even with autoDistribute ON', async () => {
    const { deps, calls } = fakeDeps({ recognition: invMatrix, resolve: [invAt('7', 10)], autoDistribute: true })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счёт СЧ-0007')]), deps)
    expect(r.ledgerWritten).toBe(0)
    expect(calls.ledger).toEqual([])
  })

  it('idempotent redelivery (row already existed) → writeLedger called but ledgerWritten stays 0', async () => {
    const { deps, calls } = fakeDeps({ recognition: provisioned, resolve: [invAt('7', 10)], autoDistribute: true, ledgerCreated: false })
    const r = await handleCrmSyncJob(job([item('d1', 'credit', 'счёт СЧ-0007')]), deps)
    expect(r.ledgerWritten).toBe(0) // no NEW row
    expect(calls.ledger).toHaveLength(1) // but the (idempotent) write was still invoked
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
  it('planFetches attaches epoch to every job when given (A10 per-tick re-fetch)', () => {
    const jobs = planFetches([{ memberId: 'M', providerId: 'alfa-by', accounts: ['A1'] }], '2026-07-01', '2026-07-02', 'tick9')
    expect(jobs[0]!.epoch).toBe('tick9')
    // omitted → no epoch key at all (base job-id stays stable)
    expect(planFetches([{ memberId: 'M', providerId: 'alfa-by', accounts: ['A1'] }], '2026-07-01', '2026-07-02')[0]!.epoch).toBeUndefined()
  })
  it('accountsForPolling groups by portal+provider, dedups, filters non-pollable + demo (A6)', () => {
    const out = accountsForPolling([
      { memberId: 'M1', provider: 'alfa-by', accountKey: 'A1' },
      { memberId: 'M1', provider: 'alfa-by', accountKey: 'A1' }, // dup → collapsed
      { memberId: 'M1', provider: 'alfa-by', accountKey: 'A2' },
      { memberId: 'M2', provider: 'alfa-by', accountKey: 'B1' },
      { memberId: 'M1', provider: 'prior-by', accountKey: 'P1' }, // prior → A5b, dropped
      { memberId: 'M1', provider: 'alfa-by', accountKey: `${DEMO_ACCOUNT_PREFIX}x` } // demo → dropped
    ])
    expect(out).toEqual([
      { memberId: 'M1', providerId: 'alfa-by', accounts: ['A1', 'A2'] },
      { memberId: 'M2', providerId: 'alfa-by', accounts: ['B1'] }
    ])
    expect(POLLABLE_PROVIDERS.has('alfa-by')).toBe(true)
    expect(POLLABLE_PROVIDERS.has('prior-by')).toBe(false)
    expect(accountsForPolling([])).toEqual([])
  })
  it('pollWindow returns [today-lookback, today] as ISO YYYY-MM-DD', () => {
    const now = new Date('2026-07-17T09:30:00.000Z')
    expect(pollWindow(now, 0)).toEqual({ dateFrom: '2026-07-17', dateTo: '2026-07-17' })
    expect(pollWindow(now, 1)).toEqual({ dateFrom: '2026-07-16', dateTo: '2026-07-17' })
    expect(pollWindow(now, 3)).toEqual({ dateFrom: '2026-07-14', dateTo: '2026-07-17' })
  })
  it('pollWindow is UTC (pins the contract at a late-UTC boundary, not server-local)', () => {
    // 23:30Z is already the NEXT day in any UTC+ server local time — a refactor to local-date
    // slicing would return 2026-07-18 here. Lock the UTC behaviour.
    const lateUtc = new Date('2026-07-17T23:30:00.000Z')
    expect(pollWindow(lateUtc, 0).dateTo).toBe('2026-07-17')
    expect(pollWindow(lateUtc, 1)).toEqual({ dateFrom: '2026-07-16', dateTo: '2026-07-17' })
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
