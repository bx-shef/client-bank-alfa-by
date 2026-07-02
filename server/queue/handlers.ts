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
import { dedupKey, splitByDirection } from '../../app/utils/statement'
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
  /** Post a chat message about one operation, if the rules allow (stage 6). */
  notifyChat: (item: StatementItem, memberId: string) => Promise<void>
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
 *  `unmatched` = new ops where nothing was written (e.g. no company → no owner).
 *  An unmatched op is NOT remembered, so a later redelivery re-attempts it once a
 *  matching company exists (attaching an unmatched operation elsewhere — follow-up).
 */
export async function handleCrmSyncJob(
  job: CrmSyncJob,
  deps: HandlerDeps
): Promise<{ processed: number, created: number, skipped: number, unmatched: number, credits: number, debits: number }> {
  // Dedupe WITHIN this batch (account|docId) first — cheap, no I/O.
  const seen = new Set<string>()
  const unique = job.items.filter((it) => {
    const key = dedupKey(it)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let created = 0
  let skipped = 0
  let unmatched = 0
  for (const item of unique) {
    const key = dedupKey(item)
    // Persistent dedup (#9): if this op already produced an activity in a prior
    // run of the (redelivered) job, don't create a second one.
    if (await deps.getActivityId(job.memberId, key)) {
      skipped++
      continue
    }
    const companyId = await deps.findCompany(item, job.memberId)
    const activityId = await deps.writeActivity(item, companyId, job.memberId)
    if (!activityId) {
      unmatched++
      continue
    }
    await deps.rememberActivity(job.memberId, key, activityId)
    await deps.notifyChat(item, job.memberId)
    created++
  }

  const { credits, debits } = splitByDirection(unique)
  return { processed: unique.length, created, skipped, unmatched, credits: credits.length, debits: debits.length }
}
