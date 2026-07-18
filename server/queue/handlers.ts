// Pure job handlers for the pipeline. Each takes a job payload + injected deps
// (I/O side-effects), so the orchestration is unit-testable with fakes; the real
// transports (bank fetch, file parse, B24 REST) are wired in worker.ts and land
// with stages 3–6. Handlers return a small summary (useful for logs/metrics).
//
// Flow:  bank-fetch ─┐                       ┌─ skip if already written (B24 marker #259)
//                    ├─► crm-sync ─ analyse ─┼─ else: find company (corr-account)
//        file-parse ─┘   (dedup, split)      ├─ write configurable activity (stamps marker)
//                                            └─ notify chat (by rules)

import type { StatementItem } from '../../app/types/statement'
import { dedupKey, isExcludedOperation, shouldNotifyChat, splitByDirection } from '../../app/utils/statement'
import { unmatchedClientNote } from '../../app/utils/unmatchedNotice'
import type { PortalSettings } from '../../app/utils/settings'
import { recognizePurposeIntents, type RecognitionIntent } from '../../app/utils/recognitionIntent'
import { isTriggerTarget, summarizeAllocation, type AllocationCandidate, type AllocationDecision } from '../../app/utils/allocation'
import type { AllocationMutationOpts } from '../../app/utils/allocationMutation'
import type { IntentResolution } from '../utils/intentResolver'
import type { CrmSyncJob, EventJob, FetchJob, ParseJob } from './topology'

/** Cap on how many recognized intents of ONE operation are sent to the REST resolver
 *  (#191). The payment purpose is payer-controlled, and recognition dedupes only by
 *  (kind,value) — a crafted purpose could yield many matches, each a REST lookup (a
 *  `payment-number` even triggers a company-wide scan). A legit purpose references a
 *  handful of ids at most, so 10 is generous; excess is dropped from resolution (the
 *  `recognized` metric still counts the op). Deeper rate-limiting is tracked in #191. */
export const MAX_RESOLVED_INTENTS_PER_OP = 10

/** Side-effects the handlers need, injected so the logic stays pure/testable.
 *  The CRM-side ops (`findCompany`/`writeActivity`/`notifyChat`) take the portal's
 *  `memberId` explicitly — deps are built once in startWorkers(), not per-job, so
 *  the portal context rides on the call, not the closure. */
export interface HandlerDeps {
  /** Pull a statement window from the bank (Alfa/Prior transport — stage 3/5). */
  fetchStatement: (job: FetchJob) => Promise<StatementItem[]>
  /** Parse an uploaded client-bank file into operations (manual import — #19). */
  parseFile: (job: ParseJob) => Promise<StatementItem[]>
  /** Look up a CRM company id by the counterparty's settlement account (the CLIENT/payer). */
  findCompany: (item: StatementItem, memberId: string) => Promise<string | null>
  /** Look up MY company id by OUR settlement account (`item.account`) — the fallback owner for an
   *  UNMATCHED-client operation (#91, §2 C.2/§5). `null` when our account isn't in the requisites. */
  findMyCompany: (item: StatementItem, memberId: string) => Promise<string | null>
  /** Write a configurable activity for one operation (stamping the B24 dedup marker
   *  atomically). Returns the created activity id, or `null` if nothing was written (e.g.
   *  no company matched, so there's no owner). Optional `note` prepends a reason block —
   *  used for the UNMATCHED-client fallback written to my company (#91). */
  writeActivity: (item: StatementItem, companyId: string | null, memberId: string, note?: string) => Promise<string | null>
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
   *  scoped to the payer `companyId` (IDOR) and dropping negative-stage entities via
   *  `isNegativeStage` (from `loadNegativeStagePredicate`; omitted → keep every stage).
   *  Called only for a matched-company op with ≥1 recognized identifier (§4 → #109
   *  lookup slice). LOG/COUNT only this slice — the candidates are NOT yet written as an
   *  allocation. Returns one resolution per intent. A REST error propagates (fail the
   *  job → clean retry), like findCompany. */
  resolveIntents: (intents: RecognitionIntent[], companyId: string, memberId: string, isNegativeStage?: (stageId: string) => boolean, configFields?: Record<string, string>) => Promise<IntentResolution[]>
  /** Load the portal's negative-stage predicate (union of invoice + deal fail/lost
   *  stages) so intent resolution drops candidates in a paid/«Не оплачен»/lost stage.
   *  Called AT MOST ONCE per job (lazily, only when the first op actually resolves
   *  intents) — the result is reused for every op. `null` ⇒ unavailable (no portal
   *  token) ⇒ resolution proceeds without stage filtering (candidates may include
   *  negative-stage entities — acceptable while nothing is written off them). A REST
   *  error propagates (fail the job → clean retry). */
  loadNegativeStagePredicate: (memberId: string) => Promise<((stageId: string) => boolean) | null>
  /** Observe the candidates each recognized intent resolved to (log-only, for coverage
   *  on real traffic before allocation is wired). Called once per matched-company op with
   *  ≥1 recognized intent — whether or not any candidate was found (so it fires even when
   *  the `resolved` counter does not). MUST NOT throw (pure observation). */
  onResolved: (item: StatementItem, resolutions: IntentResolution[], memberId: string) => void
  /** Observe the ALLOCATION DECISION for one op (§2, #109): the amount-matched outcome
   *  (`resolveAllocation` over invoice/deal-payment candidates) plus how many unconditional
   *  trigger targets (deal/smart-process) were found. This callback only OBSERVES; the
   *  amount-target fact is persisted by `recordAllocation` (#184, write-once) and — when the
   *  `autoDistribute` gate is on — the deal-payment target is also paid via `applyAllocation`
   *  (§2 mutation slice, below). Invoice-stage / trigger mutations remain a follow-up.
   *  Called once per op that resolved ≥1 candidate. MUST NOT throw (pure observation). */
  onAllocationDecision: (item: StatementItem, decision: AllocationDecision, triggerTargets: number, memberId: string) => void
  /** Record the persistent allocation fact «этот платёж → эта сущность» (#184). Called
   *  only for a decided `allocate` (the smallest-id amount target). Write-once per
   *  (portal, factKey): returns true if THIS call inserted the fact, false if one already
   *  existed (redelivery/reimport) — so the `allocated` counter is not double-bumped. v1
   *  writes only the FACT (no `payment.pay`/stage mutation). A store error propagates
   *  (fail the job → clean retry), like findCompany — it runs BEFORE the activity write. */
  recordAllocation: (item: StatementItem, target: AllocationCandidate, memberId: string) => Promise<boolean>
  /** Whether an allocation fact for this (payment → target) already exists (#109
   *  mutation slice). Now consulted ONLY for the TRIGGER path (deal/smart-process) —
   *  a trigger fire is stateless, so the fact is its only dedup. The AMOUNT mutation
   *  pre-check moved to `isTargetApplied` (reads B24 state, Фаза A). Any status
   *  (allocated or reverted) counts as existing. A store error propagates (fail the job). */
  hasAllocationFact: (item: StatementItem, target: AllocationCandidate, memberId: string) => Promise<boolean>
  /** Whether a decided AMOUNT target (deal-payment/invoice) is already applied in B24 —
   *  the payment is `paid='Y'` / the invoice is on the configured `opts.invoicePaidStageId`
   *  (Фаза A idempotency, replacing `hasAllocationFact` for the amount pre-check). Reading
   *  B24 state directly closes the pay-then-crash-before-fact re-pay window. Consulted ONLY
   *  when `autoDistribute` is on, BEFORE the mutation; false for trigger kinds (no readable
   *  state) and whenever it can't prove applied (so the pay runs). A read error propagates. */
  isTargetApplied: (item: StatementItem, target: AllocationCandidate, memberId: string, opts?: AllocationMutationOpts) => Promise<boolean>
  /** Apply the portal MUTATION that marks a decided allocate target paid (§2 mutation
   *  slice): `crm.item.payment.pay` for a deal payment; `crm.item.update` to the configured
   *  paid stage (`opts.invoicePaidStageId`) for an invoice. Called ONLY when `autoDistribute`
   *  is on and no fact existed yet. Returns whether a portal write was actually applied
   *  (false for unsupported kinds — an invoice WITHOUT a configured stage, or trigger
   *  targets deal/smart-process). Runs BEFORE the fact is recorded, so a thrown REST error
   *  leaves no fact and the retry re-attempts. */
  applyAllocation: (item: StatementItem, target: AllocationCandidate, memberId: string, opts?: AllocationMutationOpts) => Promise<boolean>
  /** Fire the portal's «деньги пришли» automation TRIGGER for a decided trigger target
   *  (deal, #79) via `crm.automation.trigger.execute` with the configured `code`. Called ONLY
   *  when `autoDistribute` is on, a `triggerCode` is configured, and no fact existed yet.
   *  BEST-EFFORT — a trigger SIGNALS money arrived (it doesn't move money), so this MUST NOT
   *  throw: a transient OR permanent-config failure (unregistered CODE, unsupported smart-
   *  process, missing token) is swallowed and returns `false`. Returns whether the trigger
   *  actually FIRED; the handler records the write-once fact ONLY on a fire. SINGLE-SHOT: the
   *  dedup marker is still written this run, so a non-fire is NOT retried on a later poll
   *  (durable trigger retry — a follow-up). */
  applyTrigger: (item: StatementItem, target: AllocationCandidate, memberId: string, code: string) => Promise<boolean>
  /** Post an ALLOCATION-error notice to the error chat `dialogId` (#184, §5): an
   *  `ambiguous` allocation (heads-up) or a `manual` one (no exact match → ручной разбор).
   *  The handler decides WHEN to call (outcome + error chat set); this is pure transport.
   *  MUST NOT throw — like notifyChat, a chat failure must never fail the job. Swallow+log. */
  notifyError: (item: StatementItem, decision: AllocationDecision, dialogId: string, memberId: string) => Promise<void>
  /** Post an UNMATCHED-client notice to the error chat `dialogId` (#91, §5): the payer company
   *  wasn't found by its account. `recordedToMyCompany` picks the wording (recorded on my company
   *  vs not recorded at all). MUST NOT throw — like notifyError, a chat failure never fails the job. */
  notifyUnmatched: (item: StatementItem, dialogId: string, recordedToMyCompany: boolean, memberId: string) => Promise<void>
  /** Post a chat message about one operation to `dialogId` (stage 6). The decision
   *  (target set + rules) is made by the handler; this is pure transport. MUST NOT
   *  throw — it runs AFTER the activity (and its marker) is written, so a propagated error
   *  would fail the job, skip the op on retry, and lose the record. Swallow+log. */
  notifyChat: (item: StatementItem, dialogId: string, memberId: string) => Promise<void>
  /** B24-side dedup (#259): the id of an activity already written for this op (found by its
   *  ORIGINATOR_ID/ORIGIN_ID marker), or null. No separate "remember" step — the marker is
   *  written atomically with the activity, so B24 itself is the dedup record. */
  getActivityId: (memberId: string, dedupKey: string) => Promise<string | null>
  /** Register a portal on ONAPPINSTALL — decrypt the refresh blob, upsert the token row. */
  savePortal: (job: EventJob) => Promise<void>
  /** Remove EVERYTHING for a portal on ONAPPUNINSTALL (uninstall always purges).
   *  `eventTs` (B24 event timestamp) records an ordering tombstone (#77) so a stale
   *  register can't resurrect the portal after this uninstall. */
  deletePortal: (memberId: string, eventTs: number) => Promise<void>
  /** Chain the normalized batch onto the crm-sync queue. */
  enqueueCrmSync: (job: CrmSyncJob) => Promise<boolean>
}

/** Apply a verified B24 event to the store — the consumer is the SINGLE writer
 *  (the webhook only verifies + enqueues). Uninstall removes everything for the
 *  portal (always). Install registers it (persists credentials). */
export async function handleEventJob(job: EventJob, deps: HandlerDeps): Promise<{ kind: string, cleaned: boolean, registered: boolean }> {
  if (job.kind === 'ONAPPUNINSTALL') {
    await deps.deletePortal(job.memberId, Number(job.ts) || 0)
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
  // The crm-sync jobId derives from batchId; fold the per-tick `epoch` in (when present) so a
  // real-poll re-fetch of the SAME window actually RE-RUNS crm-sync instead of being deduped by
  // a retained completed job — otherwise the fetch re-runs but crm-sync (and its B24-marker
  // dedup) never fires, so a same-day late-posted op wouldn't reach CRM until the window rolls.
  // A retry of the same tick keeps the same epoch → still idempotent. Window-only when no epoch
  // (manual import), so those ids are unchanged.
  const batchId = job.epoch
    ? `${job.account}:${job.dateFrom}:${job.dateTo}:${job.epoch}`
    : `${job.account}:${job.dateFrom}:${job.dateTo}`
  const chained = items.length > 0
    ? await deps.enqueueCrmSync({
        memberId: job.memberId,
        providerId: job.providerId,
        source: 'fetch',
        batchId,
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
 *  per operation apply read-before-write — skip ops already written (their B24 marker
 *  survives job redelivery, #259), else find the company, write the configurable activity
 *  (which stamps the marker atomically), and notify chat.
 *
 *  Counters: `processed` = unique ops in the batch; `skipped` = already written in
 *  a prior (redelivered) run; `created` = new activities written;
 *  `notified` = chat notifications sent (⊆ created); `unmatched` = new ops where
 *  nothing was written (e.g. no company → no owner);
 *  `recognized` = unique ops where ≥1 identifier was recognized in the purpose (§4);
 *  `resolved` = matched-company ops where ≥1 recognized intent found ≥1 allocation
 *  candidate (§4 lookup — log/count only, does not yet write an allocation);
 *  `allocatable` = resolved ops whose candidates yield an allocation (an exact amount+
 *  currency match on an invoice/deal-payment, OR ≥1 unconditional trigger target);
 *  `ambiguous` = allocatable ops where >1 distinct amount target matched (auto-allocate
 *  to the smallest id + chat heads-up); `manual` = ops with amount candidates but no
 *  exact match and no trigger (partial/group payment → «очередь ручного разбора»).
 *  `allocated` = decided `allocate` ops whose fact was FRESHLY recorded this run (#184,
 *  write-once — a redelivery does not re-count). `distributed` = ops that ALSO applied a
 *  portal mutation this run (`crm.item.payment.pay`/`crm.item.update`) OR fired an automation
 *  TRIGGER (`crm.automation.trigger.execute`, deal/smart-process, #79) — only when the
 *  `autoDistribute` gate is on (§2 mutation slice, #109); a subset of `allocated` (unsupported
 *  amount target kinds record the fact but apply nothing). Gate off ⇒ `distributed` stays 0 (fact-only).
 *  `credits`/`debits` = приход/расход split of the processed ops (for the status summary).
 *  An unmatched op writes nothing (no marker), so a later redelivery re-attempts it once a
 *  matching company exists (attaching an unmatched operation elsewhere — follow-up).
 */
export async function handleCrmSyncJob(
  job: CrmSyncJob,
  deps: HandlerDeps
): Promise<{ processed: number, created: number, notified: number, skipped: number, excluded: number, unmatched: number, recognized: number, resolved: number, allocatable: number, ambiguous: number, manual: number, allocated: number, distributed: number, credits: number, debits: number }> {
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
  // Error chat (#184, §5): ambiguous/manual allocations post a heads-up here. `dialogId`
  // empty ⇒ not configured ⇒ error notices off (same shape as the main chat target).
  const errorChat = settings?.errorChat ?? null
  // Auto-distribution gate (§2 mutation slice, #109): OFF by default ⇒ we only RECORD the
  // allocation fact (behaviour unchanged). ON ⇒ a decided `allocate` also marks the target
  // paid in the portal. `settings` null (not installed) ⇒ off.
  const autoDistribute = settings?.autoDistribute === true

  // Negative-stage predicate (union of invoice + deal fail/lost stages), loaded AT MOST
  // ONCE per job — lazily, so a batch that never resolves an intent pays nothing. Reused
  // across ops. `undefined` = not loaded yet; `null`/predicate = loaded (memoized).
  let negativeStage: ((stageId: string) => boolean) | null | undefined
  const getNegativeStage = async (): Promise<((stageId: string) => boolean) | undefined> => {
    if (negativeStage === undefined) negativeStage = await deps.loadNegativeStagePredicate(job.memberId)
    return negativeStage ?? undefined
  }

  let created = 0
  let notified = 0
  let skipped = 0
  let excluded = 0
  let unmatched = 0
  let recognized = 0
  let resolved = 0
  let allocatable = 0
  let ambiguous = 0
  let manual = 0
  let allocated = 0
  let distributed = 0
  for (const item of unique) {
    // Exclusion gate (PROCESSING.md §2 A2): an operation whose account or purpose is
    // excluded is skipped ENTIRELY — no recognition, no company lookup, no CRM activity, no
    // allocation, no chat. This is a PROCESSING exclusion (from the chat rules' excludeAccounts/
    // excludePurposePatterns), distinct from the `directions` chat-only filter below. Runs
    // before everything else so an excluded op costs no REST. `chat?.rules` holds the lists
    // (they're configured alongside the chat block); absent ⇒ nothing excluded.
    if (isExcludedOperation(item, chat?.rules)) {
      excluded++
      continue
    }
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
    // B24-side dedup (#259): if this op already produced an activity in a prior run of the
    // (redelivered) job, its marker is in B24 — don't create a second one.
    if (await deps.getActivityId(job.memberId, key)) {
      skipped++
      continue
    }
    const companyId = await deps.findCompany(item, job.memberId)
    // Intent resolution (§4 → #109 lookup, slice 3 — wiring the slice-2 dispatcher into
    // the worker): resolve the recognized identifiers to allocation candidates via the
    // entity lookups, scoped to the matched company. GATED behind the dedup skip (a
    // redelivered op is already `continue`d above, so no re-query) and a matched company
    // (no company ⇒ no IDOR scope ⇒ nothing to look up). Candidates are stage-filtered: the
    // negative-stage predicate (loaded once per job) drops paid/«Не оплачен»/lost entities,
    // so `resolved` counts only allocatable candidates. The decided allocation is now
    // persisted as a write-once FACT (#184, below); the portal mutation is a follow-up. The
    // purpose is payer-controlled, so
    // the number of intents actually sent to REST is capped (MAX_RESOLVED_INTENTS_PER_OP)
    // to bound amplification (#191); the `recognized` metric still reflects all matches.
    if (companyId && intents.length > 0) {
      const toResolve = intents.slice(0, MAX_RESOLVED_INTENTS_PER_OP)
      const isNegativeStage = await getNegativeStage()
      const resolutions = await deps.resolveIntents(toResolve, companyId, job.memberId, isNegativeStage, settings?.recognition?.configFields)
      const candidates = resolutions.flatMap(r => r.candidates)
      if (candidates.length > 0) {
        resolved++
        // Allocation decision (§2, #109): classify the resolved candidates via the pure
        // `summarizeAllocation` (amount targets amount-matched; trigger targets fire
        // unconditionally). Runs for BOTH приход and расход — per PROCESSING.md §2
        // «авто-проведение работает и для приходов, и для расходов (обе стороны)», so this
        // is intentionally NOT direction-gated. The allocation FACT is now persisted below
        // (#184, write-once); the portal MUTATION (`payment.pay`/stage) stays a follow-up
        // behind an opt-in gate. `ambiguous` is a stricter case of `allocatable`, so it bumps
        // both counters.
        const summary = summarizeAllocation({ amount: item.amount, currency: item.currency, candidates })
        if (summary.outcome === 'ambiguous') {
          allocatable++
          ambiguous++
        } else if (summary.outcome === 'allocatable') {
          allocatable++
        } else if (summary.outcome === 'manual') {
          manual++
        }
        deps.onAllocationDecision(item, summary.decision, summary.triggerTargets, job.memberId)
        // Write slice (#184): record the persistent fact for a decided `allocate` (the
        // smallest-id amount target), write-once so a redelivery/reimport can't double it
        // (the `allocated` counter bumps only on a fresh insert). The portal MUTATION
        // (`payment.pay` for deal-payment / `crm.item.update` stage for invoice) is applied
        // BEFORE the fact when the opt-in `autoDistribute` gate is on (see below); with the
        // gate off it stays fact-only. Trigger-only targets (deal/smart-process,
        // `action !== 'allocate'`) record no fact here — they fire unconditionally and their
        // write+idempotency is a follow-up.
        // Then, for an ambiguous (heads-up) or manual (no exact match) outcome, post a notice
        // to the error chat if configured. Both already gated behind the dedup-skip + matched
        // company (this block only runs then), so the scope is the payer (IDOR).
        if (summary.decision.action === 'allocate') {
          const target = summary.decision.target
          if (autoDistribute) {
            // Mutation slice (§2): mark the target paid, then record the fact. Order matters —
            // the portal write runs BEFORE the fact, so a persisted fact always implies the
            // mutation succeeded (a thrown REST error leaves no fact ⇒ clean retry). The
            // pre-check reads B24 STATE (`isTargetApplied` — payment `paid='Y'` / invoice on the
            // paid stage, Фаза A) so a redelivery/reimport never re-pays: reading the true state
            // also covers the pay-then-crash-before-fact window the fact left open. Unsupported
            // target kinds (invoice stage w/o config, trigger targets) apply nothing but still
            // record the fact (distributed not bumped).
            if (await deps.isTargetApplied(item, target, job.memberId, { invoicePaidStageId: settings?.allocation?.invoicePaidStageId })) {
              // Already applied in B24 (a prior run paid it — possibly crashing BEFORE the fact
              // write). Do NOT re-pay, but STILL record the write-once fact so accounting/reversal
              // keeps a durable record of the allocation (distributed NOT bumped — we applied
              // nothing this run). recordAllocation is write-once, so the normal case (fact already
              // present) is a no-op that bumps nothing.
              if (await deps.recordAllocation(item, target, job.memberId)) allocated++
            } else {
              const applied = await deps.applyAllocation(item, target, job.memberId, { invoicePaidStageId: settings?.allocation?.invoicePaidStageId })
              if (await deps.recordAllocation(item, target, job.memberId)) {
                allocated++
                if (applied) distributed++
              }
            }
          } else if (await deps.recordAllocation(item, target, job.memberId)) {
            // Gate OFF ⇒ fact-only (write-once), no portal mutation. Unchanged v1 behaviour.
            allocated++
          }
        }
        // Trigger targets (#79): a deal/smart-process candidate fires the portal's «деньги
        // пришли» automation trigger UNCONDITIONALLY (not amount-gated) — separate from the
        // amount `allocate` above (its `decision.target` is the amount target only). Gated on
        // the opt-in `autoDistribute` + a configured `triggerCode`. For each DISTINCT trigger
        // target (kind+id): the `hasAllocationFact` pre-check dedups within this run; `applyTrigger`
        // is BEST-EFFORT (never throws — a trigger signals, it doesn't move money) and the write-once
        // fact is recorded ONLY on a confirmed FIRE. `allocated`+`distributed` bump together on a
        // fired trigger (an un-fired one records nothing).
        // SINGLE-SHOT (important): the trigger is attempted ONCE — on this first processing of the
        // op with a matched company. `writeActivity` below persists the B24 dedup marker regardless
        // of trigger outcome, so a later redelivery/poll is `continue`d at the top gate and never
        // re-reaches this loop. Hence a first-attempt miss (transient error swallowed by best-effort,
        // OR a `triggerCode` set but not yet registered → `applyTrigger` returns false) is NOT
        // retried — the fire is lost, not self-healed. This is the accepted v1 semantic (CODE is
        // meant to be registered at install, before ops flow); durable trigger retry is a follow-up.
        const triggerCode = settings?.allocation?.triggerCode
        if (autoDistribute && triggerCode) {
          const seen = new Set<string>()
          for (const t of candidates) {
            if (!isTriggerTarget(t.kind)) continue
            const targetKey = `${t.kind}:${t.id}` // not the op dedupKey — distinct trigger target
            if (seen.has(targetKey)) continue
            seen.add(targetKey)
            if (await deps.hasAllocationFact(item, t, job.memberId)) continue
            const fired = await deps.applyTrigger(item, t, job.memberId, triggerCode)
            if (fired && await deps.recordAllocation(item, t, job.memberId)) {
              allocated++
              distributed++
            }
          }
        }
        if ((summary.outcome === 'ambiguous' || summary.outcome === 'manual') && errorChat?.dialogId) {
          await deps.notifyError(item, summary.decision, errorChat.dialogId, job.memberId)
        }
      }
      deps.onResolved(item, resolutions, job.memberId)
    }
    // Write target (PROCESSING.md §2 Этап C.2 / §5, #91). Client found → write to the client (as
    // before). Client NOT found → UNMATCHED: fall back to MY company (found by OUR account) so the
    // payment isn't lost, carrying a reason note; `unmatched` counts the payer being unidentified
    // (now it can coexist with `created`). If MY company is also missing, nothing is written and
    // the payment is reported to the error chat instead (§5). The allocation block above stays
    // gated on the CLIENT `companyId` — we never allocate to an unknown payer's invoices.
    let writeCompanyId = companyId
    let note: string | undefined
    const clientUnmatched = !companyId
    if (clientUnmatched) {
      unmatched++
      const myCompanyId = await deps.findMyCompany(item, job.memberId)
      writeCompanyId = myCompanyId
      if (myCompanyId) note = unmatchedClientNote(item)
    }
    const activityId = await deps.writeActivity(item, writeCompanyId, job.memberId, note)
    if (clientUnmatched && errorChat?.dialogId) {
      // Notify the error chat AFTER the write, so `recorded` reflects whether an activity was
      // actually created (a thrown write fails the job BEFORE this — a retry then notifies once it
      // succeeds — instead of claiming "записано" on a write that didn't land). Best-effort (the
      // dep swallows transport errors). recorded=false ⇒ my company also missing → nothing written.
      await deps.notifyUnmatched(item, errorChat.dialogId, activityId !== null, job.memberId)
    }
    if (!activityId) {
      // Nothing written: no owner company at all (client AND my company missing), or a demo/no-token
      // skip. For a real unmatched-no-my-company the payment stays un-recorded (no marker → retried
      // next poll once requisites exist); the error-chat notice above already flagged it. For a
      // matched-client write that returned null (demo/no token) — unchanged skip.
      continue
    }
    // Dedup is atomic now (#259): the ORIGINATOR_ID/ORIGIN_ID marker is written INSIDE
    // writeActivity (configurable.add), so a redelivery's getActivityId finds it — no separate
    // remember step, and no write→remember gap to lose.
    // Announce only if a chat target is set AND the rules allow this op (direction /
    // excluded account / excluded purpose). Only a MATCHED-CLIENT op is announced in the normal
    // chat — an UNMATCHED op written to my company is a problem case and was already reported to the
    // ERROR chat above (don't double-announce). notify sits after the write, so a redelivery can't
    // re-post (chat has no separate dedup yet); notifyChat swallows transport errors.
    if (companyId && chat?.dialogId && shouldNotifyChat(item, chat.rules)) {
      await deps.notifyChat(item, chat.dialogId, job.memberId)
      notified++
    }
    created++
  }

  const { credits, debits } = splitByDirection(unique)
  return { processed: unique.length, created, notified, skipped, excluded, unmatched, recognized, resolved, allocatable, ambiguous, manual, allocated, distributed, credits: credits.length, debits: debits.length }
}
