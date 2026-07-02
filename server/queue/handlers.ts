// Pure job handlers for the pipeline. Each takes a job payload + injected deps
// (I/O side-effects), so the orchestration is unit-testable with fakes; the real
// transports (bank fetch, file parse, B24 REST) are wired in worker.ts and land
// with stages 3–6. Handlers return a small summary (useful for logs/metrics).
//
// Flow:  bank-fetch ─┐                       ┌─ find company (corr-account)
//                    ├─► crm-sync ─ analyse ─┼─ write universal activity
//        file-parse ─┘   (dedup, split)      └─ notify chat (by rules)

import type { StatementItem } from '../../app/types/statement'
import { dedupKey, splitByDirection } from '../../app/utils/statement'
import type { CrmSyncJob, EventJob, FetchJob, ParseJob } from './topology'

/** Side-effects the handlers need, injected so the logic stays pure/testable. */
export interface HandlerDeps {
  /** Pull a statement window from the bank (Alfa/Prior transport — stage 3/5). */
  fetchStatement: (job: FetchJob) => Promise<StatementItem[]>
  /** Parse an uploaded client-bank file into operations (manual import — #19). */
  parseFile: (job: ParseJob) => Promise<StatementItem[]>
  /** Look up a CRM company id by the counterparty's settlement account (stage 4). */
  findCompany: (item: StatementItem) => Promise<string | null>
  /** Write a universal activity for one operation (stage 4). */
  writeActivity: (item: StatementItem, companyId: string | null) => Promise<void>
  /** Post a chat message about one operation, if the rules allow (stage 6). */
  notifyChat: (item: StatementItem) => Promise<void>
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
 *  per operation find the company, write the activity, and notify chat. */
export async function handleCrmSyncJob(
  job: CrmSyncJob,
  deps: HandlerDeps
): Promise<{ processed: number, credits: number, debits: number }> {
  // Dedupe WITHIN this batch (account|docId). NB: this does NOT protect against
  // at-least-once redelivery of the whole job (worker crash/retry after partial
  // writes) — that needs a PERSISTENT {dedupKey→activityId} store consulted
  // read-before-write in findCompany/writeActivity. That store is a BLOCKING
  // requirement for stage 4 (issue #9), before writeActivity stops being a no-op.
  const seen = new Set<string>()
  const unique = job.items.filter((it) => {
    const key = dedupKey(it)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  for (const item of unique) {
    const companyId = await deps.findCompany(item)
    await deps.writeActivity(item, companyId)
    await deps.notifyChat(item)
  }

  const { credits, debits } = splitByDirection(unique)
  return { processed: unique.length, credits: credits.length, debits: debits.length }
}
