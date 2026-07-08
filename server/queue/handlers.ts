// Pure job handlers for the pipeline. Each takes a job payload + injected deps
// (I/O side-effects), so the orchestration is unit-testable with fakes; the real
// transports (bank fetch, file parse, B24 REST) are wired in worker.ts and land
// with stages 3–6. Handlers return a small summary (useful for logs/metrics).
//
// Flow:  bank-fetch ─┐                       ┌─ skip if already written (#9 store)
//                    ├─► crm-sync ─ analyse ─┼─ else: find company (corr-account)
//        file-parse ─┘   (dedup, split)      ├─ write activity + remember its id
//                                            └─ notify chat (by rules)

import type { StatementItem } from '../../app/types/statement'
import { dedupKey, shouldNotifyChat, splitByDirection } from '../../app/utils/statement'
import type { PortalSettings } from '../../app/utils/settings'
import { recognizePurposeIntents, type RecognitionIntent } from '../../app/utils/recognitionIntent'
import type { IntentResolution } from '../utils/intentResolver'
import type { CrmSyncJob, EventJob, FetchJob, ParseJob } from './topology'

/** Side-effects the handlers need, injected so the logic stays pure/testable.
 *  The CRM-side ops (`findCompany`/`writeActivity`/`notifyChat`) take the portal's
 *  `memberId` explicitly — deps are built once in startWorkers(), not per-job, so
 *  the portal context rides on the call, not the closure. */
export interface HandlerDeps {
  /** Pull a statement window from the bank (Alfa/Prior transport — stage 3/5). */
  fetchStatement: (job: FetchJob) => Promise<StatementItem[]>
  /** Parse an uploaded client-bank file into operations (manual import — #19). */
  parseFile: (job: ParseJob) => Promise<StatementItem[]>
  /** Look up a CRM company id by the counterparty's settlement account. */
  findCompany: (item: StatementItem, memberId: string) => Promise<string | null>
  /** Write a universal activity for one operation. Returns the created activity id
   *  (to remember for dedup), or `null` if nothing was written (e.g. no company
   *  matched, so there's no owner for a todo). */
  writeActivity: (item: StatementItem, companyId: string | null, memberId: string) => Promise<string | null>
  /** Read the portal's full settings blob (chat target + rules + recognition matrices)
   *  from app.option, or null when unset/unavailable. Resolved ONCE per crm-sync job,
   *  not per operation — one app.option read feeds both the chat and recognition steps. */
  getPortalSettings: (memberId: string) => Promise<PortalSettings | null>
  /** Observe the identifiers recognized in one operation's purpose + where they'd
   *  route (§4 → #109 lookup). LOG-ONLY this slice: the REST lookup/allocation is a
   *  later crm-sync slice, so this only records the intent for visibility. Called only
   *  for ops with ≥1 recognized identifier. MUST NOT throw (pure observation). */
  onRecognized: (item: StatementItem, intents: RecognitionIntent[], memberId: string) => void
  /** Resolve recognized intents to allocation candidates via the entity lookups,
   *  scoped to the payer `companyId` (IDOR). Called only for a matched-company op with
   *  ≥1 recognized identifier (§4 → #109 lookup slice). LOG/COUNT only this slice — the
   *  candidates are NOT yet written as an allocation. Returns one resolution per intent.
   *  A REST error propagates (fail the job → clean retry), like findCompany. */
  resolveIntents: (intents: RecognitionIntent[], companyId: string, memberId: string) => Promise<IntentResolution[]>
  /** Observe the candidates each recognized intent resolved to (log-only, for coverage
   *  on real traffic before allocation is wired). Called once per resolved op. MUST NOT
   *  throw (pure observation). */
  onResolved: (item: StatementItem, resolutions: IntentResolution[], memberId: string) => void
  /** Post a chat message about one operation to `dialogId` (stage 6). The decision
   *  (target set + rules) is made by the handler; this is pure transport. MUST NOT
   *  throw — it runs AFTER the activity is written+remembered, so a propagated error
   *  would fail the job, skip the op on retry, and lose the record. Swallow+log. */
  notifyChat: (item: StatementItem, dialogId: string, memberId: string) => Promise<void>
  /** Persistent dedup: the activity id already written for this op, or null (#9). */
  getActivityId: (memberId: string, dedupKey: string) => Promise<string | null>
  /** Persistent dedup: record the activity id written for this op (#9). */
  rememberActivity: (memberId: string, dedupKey: string, activityId: string) => Promise<void>
  /** Register a portal on ONAPPINSTALL — decrypt the refresh blob, upsert the token row. */
  savePortal: (job: EventJob) => Promise<void>
  /** Remove EVERYTHING for a portal on ONAPPUNINSTALL (uninstall always purges). */
  deletePortal: (memberId: string) => Promise<void>
  /** Chain the normalized batch onto the crm-sync queue. */
  enqueueCrmSync: (job: CrmSyncJob) => Promise<boolean>
}

/** Apply a verified B24 event to the store — the consumer is the SINGLE writer
 *  (the webhook only verifies + enqueues). Uninstall removes everything for the
 *  portal (always). Install registers it (persists credentials). */
export async function handleEventJob(job: EventJob, deps: HandlerDeps): Promise<{ kind: string, cleaned: boolean, registered: boolean }> {
  if (job.kind === 'ONAPPUNINSTALL') {
    await deps.deletePortal(job.memberId)
    return { kind: job.kind, cleaned: true, registered: false }
  }
  // ONAPPINSTALL: register the portal. `credentials` is always present for a
  // register job built by the webhook; guard defensively for a malformed job.
  if (job.credentials) {
    await deps.savePortal(job)
    return { kind: job.kind, cleaned: false, registered: true }
  }
  return { kind: job.kind, cleaned: false, registered: false }
}

/** Fetch a statement window, then hand the normalized batch to crm-sync. */
export async function handleFetchJob(job: FetchJob, deps: HandlerDeps): Promise<{ fetched: number, chained: boolean }> {
  const items = await deps.fetchStatement(job)
  const chained = items.length > 0
    ? await deps.enqueueCrmSync({
        memberId: job.memberId,
        providerId: job.providerId,
        source: 'fetch',
        batchId: `${job.account}:${job.dateFrom}:${job.dateTo}`,
        items
      })
    : false
  return { fetched: items.length, chained }
}

/** Parse an uploaded file, then hand the normalized batch to crm-sync. */
export async function handleParseJob(job: ParseJob, deps: HandlerDeps): Promise<{ parsed: number, chained: boolean }> {
  const items = await deps.parseFile(job)
  const chained = items.length > 0
    ? await deps.enqueueCrmSync({
        memberId: job.memberId,
        providerId: job.providerId,
        source: 'parse',
        batchId: job.fileHash,
        items
      })
    : false
  return { parsed: items.length, chained }
}

/** Analyse a normalized batch and act in Bitrix24: dedupe within the batch, then
 *  per operation apply read-before-write — skip ops already written (persistent
 *  dedup, survives job redelivery), else find the company, write the activity,
 *  remember it, and notify chat.
 *
 *  Counters: `processed` = unique ops in the batch; `skipped` = already written in
 *  a prior (redelivered) run; `created` = new activities written + remembered;
 *  `unmatched` = new ops where nothing was written (e.g. no company → no owner);
 *  `recognized` = unique ops where ≥1 identifier was recognized in the purpose (§4);
 *  `resolved` = matched-company ops where ≥1 recognized intent found ≥1 allocation
 *  candidate (§4 lookup — log/count only, does not yet write an allocation).
 *  An unmatched op is NOT remembered, so a later redelivery re-attempts it once a
 *  matching company exists (attaching an unmatched operation elsewhere — follow-up).
 */
export async function handleCrmSyncJob(
  job: CrmSyncJob,
  deps: HandlerDeps
): Promise<{ processed: number, created: number, skipped: number, unmatched: number, recognized: number, resolved: number, credits: number, debits: number }> {
  // Dedupe WITHIN this batch (account|docId) first — cheap, no I/O.
  const seen = new Set<string>()
  const unique = job.items.filter((it) => {
    const key = dedupKey(it)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Resolve the portal settings ONCE per job (not per op) — else every operation would
  // do a fresh app.option REST read. One read feeds both chat (target + rules) and
  // recognition (matrices). null ⇒ unavailable/not installed ⇒ chat + recognition off.
  const settings = await deps.getPortalSettings(job.memberId)
  const chat = settings?.chat ?? null
  const recognition = settings?.recognition ?? null

  let created = 0
  let skipped = 0
  let unmatched = 0
  let recognized = 0
  let resolved = 0
  for (const item of unique) {
    // Recognition intent (§4, #109): recognize identifiers in the purpose by the
    // portal's matrices and route each. Pure + cheap → run for every unique op (even
    // ones skipped below) so recognition COVERAGE is observable; the intent is about the
    // operation, not whether we wrote a todo. The REST RESOLUTION of these intents is
    // gated further down (behind the dedup skip + a matched company).
    const intents = recognition ? recognizePurposeIntents(item.purpose, recognition) : []
    if (intents.length > 0) {
      recognized++
      deps.onRecognized(item, intents, job.memberId)
    }
    const key = dedupKey(item)
    // Persistent dedup (#9): if this op already produced an activity in a prior
    // run of the (redelivered) job, don't create a second one.
    if (await deps.getActivityId(job.memberId, key)) {
      skipped++
      continue
    }
    const companyId = await deps.findCompany(item, job.memberId)
    // Intent resolution (§4 → #109 lookup, slice 2 wired here): resolve the recognized
    // identifiers to allocation candidates via the entity lookups, scoped to the matched
    // company. LOG/COUNT only — no allocation is written yet. GATED behind the dedup skip
    // (a redelivered op is already `continue`d above, so no re-query) and a matched
    // company (no company ⇒ no IDOR scope ⇒ nothing to look up). Stage filtering is the
    // next sub-slice: candidates here are NOT stage-filtered, which is fine because
    // nothing is written off them. NB: this adds REST calls on matched ops with a
    // recognized id — see the rate-limit / bind-RestCall-once TODO in worker.ts.
    if (companyId && intents.length > 0) {
      const resolutions = await deps.resolveIntents(intents, companyId, job.memberId)
      if (resolutions.some(r => r.candidates.length > 0)) resolved++
      deps.onResolved(item, resolutions, job.memberId)
    }
    const activityId = await deps.writeActivity(item, companyId, job.memberId)
    if (!activityId) {
      // No client company matched (or write skipped) → UNMATCHED: we do NOT write
      // anything and do NOT remember the op, so a later redelivery re-attempts once a
      // matching company exists. This is the accepted v1 behaviour for manual import
      // (docs/PROCESSING.md §2 Этап C.2 "Текущее состояние"): the target-spec cascade
      // (attach to MY company / smart-process element) lands with #109.
      unmatched++
      continue
    }
    // NB (write→remember not atomic): if the worker dies AFTER writeActivity created
    // the B24 activity but BEFORE rememberActivity persists, a job redelivery would
    // re-create the activity (getActivityId still null). This narrow window is the
    // right trade — reserving the key BEFORE writing would instead risk a permanent
    // loss if writeActivity then failed. A B24-side guard (search the timeline for
    // the embedded origin token before writing) would close it — follow-up.
    await deps.rememberActivity(job.memberId, key, activityId)
    // Announce only if a chat target is set AND the rules allow this op (direction /
    // excluded account / excluded purpose). Unmatched ops are NOT announced — notify
    // sits after rememberActivity, so a redelivery can't re-post (chat has no separate
    // dedup yet). notifyChat swallows transport errors so a chat failure never fails
    // the job after the activity was written+remembered.
    if (chat?.dialogId && shouldNotifyChat(item, chat.rules)) {
      await deps.notifyChat(item, chat.dialogId, job.memberId)
    }
    created++
  }

  const { credits, debits } = splitByDirection(unique)
  return { processed: unique.length, created, skipped, unmatched, recognized, resolved, credits: credits.length, debits: debits.length }
}
