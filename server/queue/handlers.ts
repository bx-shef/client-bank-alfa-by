// Pure job handlers for the pipeline. Each takes a job payload + injected deps
// (I/O side-effects), so the orchestration is unit-testable with fakes; the real
// transports (bank fetch, file parse, B24 REST) are wired in worker.ts and land
// with stages 3–6. Handlers return a small summary (useful for logs/metrics).
//
// Flow:  bank-fetch ─┐                       ┌─ skip if already written (B24 marker #259)
//                    ├─► crm-sync ─ analyse ─┼─ else: find company (corr-account)
//        file-parse ─┘   (dedup, split)      ├─ write configurable activity (stamps marker)
//                                            └─ notify chat (by rules)

import { createHash } from 'node:crypto'
import type { StatementItem, BankProviderId } from '../../app/types/statement'
import { landedCleanly } from '../../app/utils/opLogPolicy'
import { dedupKey, isExcludedOperation, shouldNotifyChat, splitByDirection } from '../../app/utils/statement'
import { unmatchedClientNote } from '../../app/utils/unmatchedNotice'
import { makeProgramSample, type ProgramSample } from '../../app/utils/programFeedback'
import type { PortalSettings } from '../../app/utils/settings'
import { recognizePurposeIntents, type RecognitionIntent } from '../../app/utils/recognitionIntent'
import { isTriggerTarget, summarizeAllocation, type AllocationCandidate, type AllocationDecision } from '../../app/utils/allocation'
import {
  allocationTargetRef, companyRef, itemRef, planActivityBindings, type CrmEntityRef
} from '../../app/utils/activityBindings'
import type { BindingOutcome } from '../utils/activityBindingsWrite'
import type { AllocationMutationOpts } from '../../app/utils/allocationMutation'
import type { IntentResolution } from '../utils/intentResolver'
import { parseConfiguredEntityTypeId, SMART_ENTITY_CONFIG_KEY } from '../utils/intentResolver'
import { distributionSpRef as readDistributionSpRef, paymentSpRef as readPaymentSpRef, type SpRef } from '../../app/config/distributionSp'
import type { CrmSyncJob, EventJob, FetchJob, ParseJob } from './topology'
import type { TriggerOutcome } from '../utils/applyTriggerDep'

/** Cap on how many recognized intents of ONE operation are sent to the REST resolver
 *  (#191). The payment purpose is payer-controlled, and recognition dedupes only by
 *  (kind,value) — a crafted purpose could yield many matches, each a REST lookup (a
 *  `payment-number` even triggers a company-wide scan). A legit purpose references a
 *  handful of ids at most, so 10 is generous; excess is dropped from resolution (the
 *  `recognized` metric still counts the op). Deeper rate-limiting is tracked in #191. */
/** Потолок задач-дозаписей на один прогон — см. `deferredQueued` в `handleCrmSyncJob`. */
export const MAX_DEFERRED_WRITES_PER_RUN = 25

export const MAX_RESOLVED_INTENTS_PER_OP = 10

/** Потолок сообщений «цель не найдена» на один прогон (#421) — см. комментарий у счётчика. */
export const MAX_UNRESOLVED_NOTICES = 5

/** What became of one operation, for the per-op observation callback (`onOperation`). */
export interface OperationOutcome {
  /** Who the activity was attached to: the payer's own company, OUR company as the
   *  unmatched-client fallback (#91), or nobody (neither resolved → nothing written). */
  owner: 'client' | 'my-company' | 'none'
  /** How many identifiers the portal's matrices recognized in the purpose (§4). Zero here
   *  on a live portal means the «карта сопоставления» does not describe its numbering. */
  recognized: number
  /** The activity that was written, or null when nothing was (no owner / demo / no token). */
  activityId: string | null
}

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
  /**
   * Registry write (#575): ensure the payment SP carries an element for THIS operation.
   *
   * ⚠ Called for EVERY non-excluded, non-skipped operation — independent of `autoDistribute`, of
   * whether the client was identified, and of whether a target was found. The SP is named
   * «Импорт выписки: платежи» and the owner expects a registry of payments; until #575 an element
   * appeared only when an allocation SUCCEEDED, so a portal whose payers are not in CRM saw an
   * empty SP beside a working import. Idempotent by the same operation key as the activity marker.
   * Returns the element id (or null when the SP is not provisioned / on a demo portal).
   */
  writePaymentRegistry?: (item: StatementItem, companyId: string | null, memberId: string, provider: BankProviderId, paymentSp: SpRef) => Promise<string | null>
  /** Привязать дело к сущностям CRM (#579, шаг 3): элемент реестра, сущность списания, обе
   *  компании. ЛУЧШИЕ УСИЛИЯ — возвращает, сколько привязок не удалось, и НИКОГДА не бросает:
   *  дело уже записано и промаркировано, а падение здесь отменило бы всю оставшуюся пачку, не
   *  поставив привязки всё равно (повтор упрётся в маркер). */
  bindActivity?: (activityId: string, refs: CrmEntityRef[], memberId: string) => Promise<BindingOutcome>
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
   *  stages — plus a custom smart process's FAIL stages when `smartEntityTypeId` is given)
   *  so intent resolution drops candidates in a paid/«Не оплачен»/lost stage.
   *  Called AT MOST ONCE per job (lazily, only when the first op actually resolves
   *  intents) — the result is reused for every op. `null` ⇒ unavailable (no portal
   *  token) ⇒ resolution proceeds without stage filtering (candidates may include
   *  negative-stage entities — acceptable while nothing is written off them). A REST
   *  error propagates (fail the job → clean retry). */
  loadNegativeStagePredicate: (memberId: string, smartEntityTypeId?: number | null) => Promise<((stageId: string) => boolean) | null>
  /** Observe the candidates each recognized intent resolved to (log-only, for coverage
   *  on real traffic before allocation is wired). Called once per matched-company op with
   *  ≥1 recognized intent — whether or not any candidate was found (so it fires even when
   *  the `resolved` counter does not). MUST NOT throw (pure observation). */
  onResolved: (item: StatementItem, resolutions: IntentResolution[], memberId: string) => void
  /** Observe the ALLOCATION DECISION for one op (§2, #109): the amount-matched outcome
   *  (`resolveAllocation` over invoice/deal-payment candidates) plus how many unconditional
   *  trigger targets (deal/smart-process) were found. This callback only OBSERVES; the durable
   *  allocation record is the dist-СП distribution row (`writeLedger`, §9.3 #6 — Postgres
   *  `allocation_fact` retired) and — when the `autoDistribute` gate is on — the target is also
   *  paid via `applyAllocation` (§2 mutation slice, below).
   *  Called once per op that resolved ≥1 candidate. MUST NOT throw (pure observation). */
  onAllocationDecision: (item: StatementItem, decision: AllocationDecision, triggerTargets: number, memberId: string) => void
  /** Observe the OUTCOME of one operation — who ended up owning it and whether anything was
   *  written. Called once per unique, non-excluded, non-skipped op, right after `writeActivity`,
   *  REGARDLESS of the result.
   *
   *  This is the only callback that fires for an op that matched NOTHING, and that is the point:
   *  `onRecognized`/`onResolved`/`onAllocationDecision` all require the op to have got somewhere
   *  first, so a portal whose every payment goes `unmatched` produced ZERO log lines — the summary
   *  said «117 processed, 117 unmatched» and nothing said WHICH account failed to resolve. That is
   *  the one fact needed to fix it (the counterparty's account is what `findCompany` searches for
   *  in the CRM requisites), and it was the one fact nowhere to be found.
   *
   *  Optional so existing wirings/tests keep type-checking. MUST NOT throw (pure observation). */
  onOperation?: (item: StatementItem, outcome: OperationOutcome, memberId: string) => void
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
   *  process, missing token) is swallowed. Returns a TriggerOutcome (#79): 'fired' (record the fact +
   *  count), 'skip' (demo / malformed CODE — do nothing), or 'retry' (a transient / not-yet-registered
   *  miss → the handler enqueues the durable retry so the signal self-heals). Never throws. */
  applyTrigger: (item: StatementItem, target: AllocationCandidate, memberId: string, code: string) => Promise<TriggerOutcome>
  /** Enqueue a durable retry for a MISSED trigger fire (#79) so a transient / not-yet-registered miss
   *  self-heals with backoff. BEST-EFFORT (never throws — a trigger only signals). Optional: absent /
   *  no-op (no Redis) ⇒ the trigger degrades to the prior SINGLE-SHOT behaviour. */
  enqueueTriggerRetry?: (item: StatementItem, target: AllocationCandidate, memberId: string, code: string) => Promise<void>
  /** Долговременный ретрай записи элемента реестра (#578). Отсутствует ⇒ поведение прежнее: отказ
   *  посчитан и потерян. Обязан НЕ бросать — постановка задачи не может отменить обработку пачки. */
  enqueueRegistryRetry?: (item: StatementItem, companyId: string | null, memberId: string, provider: BankProviderId, paymentSp: SpRef) => Promise<void>
  /** Долговременный ретрай привязок дела (#585). Те же правила. */
  enqueueBindRetry?: (activityId: string, refs: CrmEntityRef[], memberId: string) => Promise<void>
  /** Write the decided allocation into the SP-LEDGER (#109 §9.1/§9.3): ensure the payment carrier
   *  element for the operation, add the distribution row for `target`, recompute «осталось». Called
   *  ONLY when `autoDistribute` is on AND both SP entityTypeIds are provisioned (the chooseCarrier
   *  «носитель = смарт-процесс» signal) — ADDITIVE to `applyAllocation`, does NOT replace the
   *  activity дело (carrier-exclusivity is deferred). Idempotent by markers (redelivery no-ops).
   *  Returns whether a NEW distribution row was created (for the counter). Optional: absent ⇒ no
   *  ledger write (unchanged behaviour). Throws on a REST error ⇒ clean BullMQ retry. */
  writeLedger?: (item: StatementItem, target: AllocationCandidate, companyId: string, memberId: string, etids: { paymentSp: SpRef, distributionSp: SpRef }) => Promise<boolean>
  /** Whether a TRIGGER fire for this (payment → deal/smart-process target) is already recorded in the
   *  SP-ledger — the dist-СП dedup marker exists (#109 §9.3 #6). Replaces the Postgres
   *  `hasAllocationFact` for the trigger pre-check. Consulted ONLY when both SP entityTypeIds are
   *  provisioned. A REST error propagates (fail the job → clean retry). Optional (absent ⇒ no SP
   *  dedup — single-shot via the activity marker only). */
  hasTriggerFact?: (item: StatementItem, target: AllocationCandidate, memberId: string, etids: { paymentSp: SpRef, distributionSp: SpRef }) => Promise<boolean>
  /** Record a fired TRIGGER in the SP-ledger (#109 §9.3 #6): ensure the payment carrier, add a
   *  ZERO-amount distribution row (the durable dedup marker + audit «триггер отправлен»; no «осталось»
   *  impact). Replaces the Postgres `recordAllocation` for the trigger path. Called ONLY on a
   *  confirmed FIRE when both SP entityTypeIds are provisioned. Returns whether a NEW row was created
   *  (for the counter). Optional (absent ⇒ no durable trigger record). Throws ⇒ clean BullMQ retry. */
  writeTriggerFact?: (item: StatementItem, target: AllocationCandidate, companyId: string, memberId: string, etids: { paymentSp: SpRef, distributionSp: SpRef }) => Promise<boolean>
  /** Post an ALLOCATION-error notice to the error chat `dialogId` (#184, §5): an
   *  `ambiguous` allocation (heads-up) or a `manual` one (no exact match → ручной разбор).
   *  The handler decides WHEN to call (outcome + error chat set); this is pure transport.
   *  MUST NOT throw — like notifyChat, a chat failure must never fail the job. Swallow+log. */
  notifyError: (item: StatementItem, decision: AllocationDecision, dialogId: string, memberId: string) => Promise<void>
  /** Сообщить в чат ошибок, что номер в назначении распознан, но цель в CRM не нашлась (#421).
   *  MUST NOT throw — как и `notifyError`, сбой чата не роняет джобу. */
  notifyUnresolved: (item: StatementItem, identifiers: string[], dialogId: string, memberId: string, truncated: boolean) => Promise<void>
  /** «Карта распознавания настроена неверно» (#572) — ОДИН раз за прогон, не на операцию: имя поля
   *  задаёт админ, и отказ портала одинаков для всех операций пачки. MUST NOT throw — как и
   *  остальные оповещения, сбой чата не роняет джобу. */
  /** ⚠ `account` — счёт операции, на которой это вскрылось. Нужен ТОЛЬКО для демо-гейта: у
   *  соседних оповещений он берётся из `item`, а сюда item не приходит по построению (сообщение про
   *  настройку, а не про платёж). Без него гейт поставить негде, и обещание «те же гарантии, что у
   *  notifyUnresolved» стало бы неправдой. */
  notifySettingsError: (reason: string, dialogId: string, memberId: string, account: string) => Promise<void>
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
  /**
   * Кому раздать выписку по этому счёту (#615): порталам, чей счёт ПОДТВЕРДИЛ БАНК.
   *
   * Опрос совместного счёта теперь ОДИН на все порталы (иначе они гоняются за ротацией refresh и
   * убивают грант друг другу — механизм ежедневной смерти Альфы, #488), поэтому получателей у
   * одной пачки может быть несколько.
   *
   * ⚠ Введённый номер счёта доказательством НЕ является: его вписывают руками и мы его не
   * проверяем. Первая редакция сопоставляла порталы по нему и была утечкой между клиентами —
   * админ чужого портала вписывал ваш IBAN и получал вашу выписку себе в CRM.
   *
   * ⚠ Спрашивается ЗДЕСЬ, а не кладётся в задачу планировщиком: между планом и исполнением портал
   * могли отключить, и раздача по устаревшему списку записала бы операции тому, кто нас только
   * что убрал. Свежий список стоит одного запроса к своей базе — задача только что сходила в банк.
   *
   * ⚠ ОПРАШИВАВШИЙ ПОРТАЛ ОБЯЗАН БЫТЬ В СПИСКЕ. Он сходил в банк своим грантом, и банк отдал ему
   * эту выписку — гейт подтверждения существует для СОСЕДЕЙ, а не для хозяина. Первая редакция
   * требовала подтверждения от всех и молча останавливала запись в CRM у всех обычных порталов:
   * подтверждение спрашивается только про СПОРНЫЕ счета, а у большинства счёт уникален, поэтому
   * его не было бы никогда. Симптом — тишина в CRM при живом `[fetch]`, без единой ошибки.
   */
  portalsForAccount: (job: FetchJob) => Promise<string[]>
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

/**
 * Stable content fingerprint of a fetched batch — the part of the crm-sync `batchId` that makes it
 * change exactly when the DATA changes (see handleFetchJob). Built from each operation's dedup key
 * plus the fields a correction could alter (amount/currency/purpose), so a re-poll that returns the
 * same operations produces the same hash (dedupe, no wasted CRM work) while a new or amended
 * operation produces a different one (processed). Order-independent: banks may reorder rows, and a
 * reorder is not a change. Pure.
 */
export function batchContentHash(items: readonly StatementItem[]): string {
  const lines = items.map(i => `${dedupKey(i)}|${i.amount}|${i.currency}|${i.purpose}`).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

/** Fetch a statement window, then hand the normalized batch to crm-sync. */
export async function handleFetchJob(
  job: FetchJob, deps: HandlerDeps
): Promise<{ fetched: number, chained: boolean, portals: number }> {
  const items = await deps.fetchStatement(job)
  // The crm-sync jobId derives from batchId, and crm-sync RETAINS completed jobs
  // (STATEMENT_JOB_RETENTION) — so a batchId that repeats is silently dropped by BullMQ's
  // duplicate-id handling. The id must therefore change exactly when the DATA changes:
  //
  //  - window-only (`account:from:to`) would be constant for the whole UTC day, so every re-poll
  //    after the first would be discarded before reaching CRM — the bank polled, the budget spent,
  //    and a late-posted operation lost until the window rolls. (This is why the cron used to fold
  //    a per-tick `epoch` in; it no longer can — the fetch jobId must stay stable for backpressure.)
  //  - a per-tick token would make EVERY re-poll a new crm-sync run even when nothing changed,
  //    burning B24 REST on rediscovering already-written operations at 31k accounts.
  //
  // So the batch is keyed by its CONTENT: identical operations dedupe (cheap no-op), and any new
  // or changed operation yields a new id and is processed. A retry of the same fetch re-derives
  // the same hash → still idempotent. `epoch` (manual «Опросить сейчас») is deliberately NOT part
  // of it: an operator-forced refetch of unchanged data need not redo the CRM work either.
  const batchId = `${job.account}:${job.dateFrom}:${job.dateTo}:${batchContentHash(items)}`
  // ⚠ Пустую пачку не раздаём и получателей не спрашиваем: запрос к базе ради «операций не было»
  // это трата на каждом тике каждого счёта, то есть на подавляющем большинстве тиков.
  if (items.length === 0) return { fetched: 0, chained: false, portals: 0 }

  // ⚠ ОДИН опрос — НЕСКОЛЬКО получателей (#615), но только тех, чей счёт подтвердил банк.
  // `crmSyncJobId` = `crm|memberId|batchId`, поэтому задачи разных порталов не схлопываются и
  // дедуп у каждого свой — это уже так работало, менять не пришлось.
  const targets = await deps.portalsForAccount(job)

  // ⚠ Пусто — редкий и честный исход: проводка сочла, что отдавать некому. Живая проводка всегда
  // включает сюда опрашивавший портал (он сходил в банк своим грантом), поэтому на практике это
  // означает демо-путь или отсутствие проводки вовсе. Подставлять `job.memberId` ЗДЕСЬ не нужно:
  // решение «кому отдать» принимает одно место, и дублировать его правило значит однажды разойтись.
  if (targets.length === 0) return { fetched: items.length, chained: false, portals: 0 }

  let chained = false
  for (const memberId of targets) {
    // ⚠ Отказ постановки ОДНОМУ порталу не отменяет остальных, и это ДЕЛАЕТСЯ, а не только
    // утверждается: `enqueueCrmSync` своих ошибок не глотает, и без `try` обрыв Redis между двумя
    // получателями уронил бы задачу целиком — BullMQ повторил бы её и заново сходил бы В БАНК ради
    // очереди, которая моргнула. Первая редакция несла ровно этот комментарий БЕЗ `try` (находка
    // ревью): текст обещал изоляцию, которой в коде не было.
    //
    // ⚠ Повтор безопасен: `crmSyncJobId` = `crm|memberId|batchId`, поэтому уже поставленные
    // получатели дедуплицируются очередью, а не задваиваются.
    try {
      if (await deps.enqueueCrmSync({ memberId, providerId: job.providerId, source: 'fetch', batchId, items })) {
        chained = true
      }
    } catch {
      // Считать отдельно нечего: сводка прогона и так покажет, что часть получателей не дошла,
      // а сам отказ очереди виден в её собственных счётчиках.
    }
  }
  return { fetched: items.length, chained, portals: targets.length }
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

/**
 * Поставить дозапись в CRM, не позволив САМОЙ постановке уронить обработку пачки (#578/#585).
 *
 * ⚠ Обе починки проходят через одну обёртку намеренно: правило у них одно («проверить наличие
 * зависимости, проглотить отказ, никогда не бросать»), а записанное дважды оно однажды поменяется
 * в одном месте. Первая редакция держала правило реестра развёрнутым по месту, и именно та копия
 * была бы забыта: она спрятана внутри `catch` на три уровня вложенности.
 */
async function queueDeferredWrite(work: (() => Promise<void>) | undefined | false): Promise<void> {
  if (!work) return
  try {
    await work()
  } catch { /* очередь недоступна — остаёмся при прежнем поведении: отказ посчитан */ }
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
 *  `allocated` = decided `allocate`/trigger ops whose durable record — the dist-СП distribution
 *  row — was FRESHLY written this run (§9.3 #6, idempotent by marker; Postgres `allocation_fact`
 *  retired). A redelivery finds the row and does not re-count. Bumps ONLY when both SPs are
 *  provisioned; WITHOUT SP there is no durable per-target fact (op-level dedup = the B24 activity
 *  marker), so `allocated` stays 0 for that op. `distributed` = ops that ALSO applied a portal
 *  mutation this run (`crm.item.payment.pay`/`crm.item.update`) OR fired an automation TRIGGER
 *  (`crm.automation.trigger.execute`, deal/smart-process, #79) — only when the `autoDistribute`
 *  gate is on (§2 mutation slice, #109). With SP provisioned it nests under a freshly-created row
 *  ⇒ a subset of `allocated`; WITHOUT SP a mutation can apply while `allocated` stays 0, so the
 *  subset relation holds only in the provisioned (default-ON) case. Gate off ⇒ `distributed` stays 0.
 *  `credits`/`debits` = приход/расход split of the processed ops (for the status summary).
 *  An unmatched op writes nothing (no marker), so a later redelivery re-attempts it once a
 *  matching company exists (attaching an unmatched operation elsewhere — follow-up).
 */

export async function handleCrmSyncJob(
  job: CrmSyncJob,
  deps: HandlerDeps
): Promise<{ processed: number, landed: number, created: number, notified: number, skipped: number, excluded: number, registryFailed: number, bindingsFailed: number, unmatched: number, unresolved: number, misconfigured: number, recognized: number, resolved: number, allocatable: number, ambiguous: number, manual: number, allocated: number, distributed: number, ledgerWritten: number, credits: number, debits: number, misconfigReason?: string, sample?: ProgramSample }> {
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
  // SP-ledger carrier (§9.1): both entityTypeIds provisioned ⇒ the payment is carried as an SP
  // element and its allocation is written to the ledger (chooseCarrier «носитель = смарт-процесс»).
  // Not provisioned ⇒ null ⇒ ledger write skipped (activity дело remains the record). Read once.
  const ledgerPaymentRef = readPaymentSpRef(settings?.recognition?.configFields)
  const ledgerDistributionRef = readDistributionSpRef(settings?.recognition?.configFields)

  // Negative-stage predicate (union of invoice + deal fail/lost stages), loaded AT MOST
  // ONCE per job — lazily, so a batch that never resolves an intent pays nothing. Reused
  // across ops. `undefined` = not loaded yet; `null`/predicate = loaded (memoized).
  let negativeStage: ((stageId: string) => boolean) | null | undefined
  // Configured smart-process entityTypeId (portal-specific) so the predicate can also
  // exclude a lost SP element — same config value the resolver uses for smart-id/smart-field
  // (§4). Absent/blank/non-numeric ⇒ null ⇒ SP not stage-loaded (unchanged behaviour).
  const smartEntityTypeId = parseConfiguredEntityTypeId(settings?.recognition?.configFields?.[SMART_ENTITY_CONFIG_KEY])
  const getNegativeStage = async (): Promise<((stageId: string) => boolean) | undefined> => {
    if (negativeStage === undefined) negativeStage = await deps.loadNegativeStagePredicate(job.memberId, smartEntityTypeId)
    return negativeStage ?? undefined
  }

  let created = 0
  let notified = 0
  let skipped = 0
  let excluded = 0
  /** Operations whose registry element could not be written (#575) — see the call site. */
  let registryFailed = 0
  let bindingsFailed = 0
  /**
   * Сколько дозаписей ставим за прогон (#578/#585, находка ревью).
   *
   * ⚠ Отказ реестра почти всегда СИСТЕМНЫЙ, а не про конкретный платёж: смарт-процесс удалён, право
   * отозвано, портал на обслуживании. Тогда падает КАЖДАЯ операция, и без потолка выписка на 500
   * строк заводит 500 задач по 8 попыток — до 4000 обречённых вызовов в тот же пер-портальный
   * лимитер 2 req/s, где живут и опрос, и продление токена, и чат. Клиент платит бюджетом за
   * попытки, которые не могут удаться.
   *
   * ⚠ Различать «транзиентный» и «постоянный» ПО ТЕКСТУ ошибки мы не будем: через SDK доезжает
   * только локализованное сообщение портала, без кода (тот же довод, что в `activityBindingsWrite`).
   * Потолок решает ту же задачу честнее: единичный сбой лечится полностью, а системный не
   * превращается в усилитель нагрузки — и виден оператору по счётчику, который считает ВСЕ отказы,
   * а не только поставленные задачи.
   */
  let deferredQueued = 0
  /**
   * «Моя компания» по НАШЕМУ счёту — запоминается на прогон (#579).
   *
   * ⚠ Раньше она искалась только когда клиент не опознан. Привязкам она нужна ВСЕГДА (дело обязано
   * связывать обе стороны платежа), а поиск — это три вызова в портал. Без памяти пачка из сотни
   * операций одного счёта дала бы триста одинаковых запросов; ключ — наш счёт, потому что именно
   * он и решает, чья это компания.
   *
   * ⚠ Отрицательный ответ кэшируется тоже: «в реквизитах нет нашего счёта» — состояние портала, а
   * не сбой, и переспрашивать его на каждой операции значит платить втройне за один и тот же «нет».
   */
  const myCompanyByAccount = new Map<string, string | null>()
  const resolveMyCompany = async (item: StatementItem): Promise<string | null> => {
    const cached = myCompanyByAccount.get(item.account)
    if (cached !== undefined) return cached
    const found = await deps.findMyCompany(item, job.memberId)
    myCompanyByAccount.set(item.account, found)
    return found
  }
  let unmatched = 0
  let landed = 0
  // Номер распознан, компания найдена, а цели в CRM нет (#421). Раньше этот случай не попадал
  // никуда: сообщения строились только внутри ветки «кандидаты есть».
  let unresolved = 0
  // Сколько сообщений «цель не найдена» позволено за ОДИН прогон. В отличие от `ambiguous`/`manual`
  // (редких по природе) это состояние НАСТРОЙКИ: кривая маска или лишний шаблон дают его на 100%
  // операций, и выписка на 500 строк вылилась бы в 500 одинаковых сообщений в чат, который заведён
  // ради редких случаев «нужен человек» — его просто перестали бы читать. Счётчик `unresolved`
  // капом НЕ ограничен: метрика обязана остаться честной.
  let unresolvedNotices = 0
  // ⚠ Причина ОДНА на прогон, а не список: отказ портала «такого поля нет» одинаков для каждой
  // операции, и накопление дало бы сотню одинаковых строк. Храним первую увиденную.
  let misconfigured = 0
  // ⚠ Persistent-признак для экрана готовности (#595): ПЕРВАЯ структурированная причина misconfig,
  // увиденная в прогоне. Срабатывает на ЛЮБОЙ misconfigured-резолюции (как и сообщение в чат ниже),
  // а не на узком счётчике `misconfigured` (тот требует candidates.length===0): портал с одной
  // рабочей и одной сломанной матрицей должен светить красным, хотя платёж и разнёсся по рабочей.
  // Пусто ⇒ прогон чистый ⇒ признак сбросится (см. worker `persistImportResult`).
  let misconfigReason: string | undefined
  // ⚠ Одно сообщение за прогон: причина одинакова для каждой операции пачки (админ указал
  // несуществующее поле или смарт-процесс), и построчно оно залило бы чат ошибок — ровно то, из-за
  // чего такой чат перестают читать.
  let settingsNoticeSent = false
  let recognized = 0
  let resolved = 0
  let allocatable = 0
  let ambiguous = 0
  let manual = 0
  let allocated = 0
  let distributed = 0
  let ledgerWritten = 0
  // First confused op (unmatched/ambiguous/manual), captured redacted for the program feedback issue
  // (docs/FEEDBACK.md channel 2). Only ONE — dedup keeps the issue to one/shape/hour. `??=` keeps the
  // earliest confused op in iteration order.
  let sample: ProgramSample | undefined
  for (const item of unique) {
    // Exclusion gate (PROCESSING.md §2 A2): an operation whose account or purpose is
    // excluded is skipped ENTIRELY — no recognition, no company lookup, no CRM activity, no
    // allocation, no chat. This is a PROCESSING exclusion (from the chat rules'
    // excludeCounterpartyAccounts/excludePurposePatterns), distinct from the chat-only filter. Runs
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
    // ─── Реестр платежей (#575) ───────────────────────────────────────────────────────────────
    // Элемент СП пишется ПЕРВЫМ — раньше и разнесения, и дела.
    //
    // ⚠ Несущая причина ровно ОДНА — разнесение (следующий абзац). Соблазнительный довод «раньше
    // дела, чтобы упавшая запись не оставила маркера и повтор прошёл операцию заново» ЛОЖЕН, и
    // держать его тут вредно: отказ реестра ПРОГЛАТЫВАЕТСЯ, а `writeActivity` вызывается сразу
    // после — безусловно, не по исходу реестра. Значит маркер встанет в этом же проходе при любом
    // порядке, и никакого самолечения ретраем нет. Обратное утверждение убеждало бы следующего
    // читателя, что потерянный элемент «когда-нибудь допишется сам».
    //
    // ⚠ Раньше РАЗНЕСЕНИЯ — потому что `writeLedgerAllocation`/`writeTriggerLedgerFact` зовут тот же
    // `ensurePaymentElement`, но БЕЗ полей реестра, а он при найденном маркере не дописывает ничего.
    // Отработай разнесение первым — элемент создался бы голым, реестр нашёл бы маркер занятым и
    // тихо вышел: колонки не появились бы, и это даже не посчиталось бы отказом. Сегодня ветка не
    // срабатывает (совпадений «плательщик в CRM» ноль — та самая причина, ради которой #575 и
    // заведён), поэтому промах был бы латентным и выстрелил бы ровно тогда, когда контрагентов
    // начнут заводить: в реестре вперемешку строки с контрагентом и без. Это читается как порча
    // данных, а не как понятный дефект. Порядок и есть починка — обе стороны сходятся на маркере,
    // и кто пришёл первым, тот и создал.
    //
    // ⚠ Отказ ПРОГЛАТЫВАЕТСЯ, в отличие от `writeLedger`, который пробрасывает. Тот писал только на
    // удавшемся разнесении, то есть редко; этот зовётся на КАЖДУЮ операцию, и проброс отменил бы
    // всю пачку на первой же плохой — и так на каждом повторе. Операции до неё остаются с делами,
    // операции после не получают ничего: снаружи импорт, вставший на середине без объяснения.
    // Согласованный процесс (PROCESSING.md, Этап D) ставит дело первым — «ДЕЛО — ВСЕГДА», — и
    // вторичная запись не имеет права держать первичную в заложниках.
    //
    // ⚠ Цена названа честно: проглоченный отказ означает потерянный навсегда элемент (следующий
    // опрос упрётся в маркер дела). Поэтому он СЧИТАЕТСЯ и печатается в безусловной строке итога —
    // молчащий пустой СП при живом импорте это ровно тот симптом, ради которого #575 и заведён.
    //
    // ⚠ Отсутствующие поля отказом НЕ являются: `crm.item.add` молча игнорирует неизвестные UF-ключи
    // (замерено на живом портале 2026-08-22), поэтому СП, созданный до #575, продолжает получать
    // элементы — просто без колонок реестра, пока администратор не перезапустит провижининг.
    // id элемента нужен привязкам дела (#579): из карточки платежа человек должен попадать в
    // реестр и обратно. Отдельного прохода за ним не нужно — элемент пишется ДО дела (см. выше).
    let registryElementId: string | null = null
    if (ledgerPaymentRef && deps.writePaymentRegistry) {
      try {
        registryElementId = await deps.writePaymentRegistry(item, companyId, job.memberId, job.providerId, ledgerPaymentRef)
      } catch {
        registryFailed++
        // ⚠ Дозапись отдельной задачей (#578). Без неё проглоченный отказ терял элемент НАВСЕГДА:
        // повтор джобы упирается в маркер дела и до реестра не доходит. Постановка — best-effort:
        // без Redis это no-op, а её собственный отказ не имеет права отменить обработку пачки.
        if (deferredQueued < MAX_DEFERRED_WRITES_PER_RUN) {
          deferredQueued++
          await queueDeferredWrite(deps.enqueueRegistryRetry
            && (() => deps.enqueueRegistryRetry!(item, companyId, job.memberId, job.providerId, ledgerPaymentRef)))
        }
      }
    }
    // Error-chat notice for an ambiguous/manual allocation, captured here but EMITTED only after
    // the dedup marker is committed (below) — im.message.add has no dedup, so posting it before the
    // marker would let a job-level retry re-post it. Job retries are more frequent now that the SDK
    // in-client retry is off (#123), which is exactly why this must sit behind the marker.
    let errorNotice: AllocationDecision | null = null
    // Сущности списания, к которым надо привязать дело (#579). Собираются здесь, а ставятся ПОСЛЕ
    // маркера — как и всё остальное в этом цикле, что нельзя повторить безнаказанно.
    const writeOffTargets: Array<Pick<AllocationCandidate, 'kind' | 'id'> & { dealId?: string, entityTypeId?: number }> = []
    // Распознанные, но не нашедшие цели номера (#421) — отправляются ПОСЛЕ записи маркера, как и
    // `errorNotice`: иначе повторная доставка джобы переслала бы сообщение (у чата дедупа нет).
    let unresolvedIds: string[] = []
    // Trigger candidates to fire (#79 / C2 double-fire): captured here but FIRED only after
    // `writeActivity` stamps the dedup marker (below). Firing before the marker means a transient
    // `writeActivity` failure retries the whole job, and — with NO SP-ledger fact to dedup against —
    // re-reaches the trigger block and fires the payer's «деньги пришли» automation a SECOND time.
    // Deferring past the marker makes the top-gate `getActivityId` short-circuit the redelivery
    // before it can re-fire, the same protection `errorNotice`/`unresolvedIds` already rely on.
    let triggerCandidates: AllocationCandidate[] = []
    let truncatedIntents = false
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
    // Zero-amount guard (C4): a non-positive amount is a parse artifact (Deb=Cre=0, or a foreign
    // -currency line whose `…Q` field was missing so the amount fell to 0) — never real money. Such
    // an op would EXACT-match a candidate whose own amount is 0 and get auto-allocated/triggered. We
    // still write the дело below (a human sees the artifact), but drive no allocation off it.
    if (companyId && intents.length > 0 && item.amount > 0) {
      const toResolve = intents.slice(0, MAX_RESOLVED_INTENTS_PER_OP)
      const isNegativeStage = await getNegativeStage()
      const resolutions = await deps.resolveIntents(toResolve, companyId, job.memberId, isNegativeStage, settings?.recognition?.configFields)
      const candidates = resolutions.flatMap(r => r.candidates)
      // «Искали и не нашли» — это ТОЛЬКО резолюции со статусом `resolved`. `unsupported` значит
      // «вид не настроен» (нет `smart-entity`/`deal-field` в карте), там в CRM никто ничего не
      // искал: сообщать про «нет подходящих счетов» было бы прямой ложью, а совет «проверьте номер
      // и статус документа» отправил бы бухгалтера искать несуществующую проблему вместо настройки.
      const searched = resolutions.filter(r => r.status === 'resolved')
      // Портал не принял настройку из «карты распознавания» (#572).
      // ⚠ Считаем ОПЕРАЦИИ, а не резолюции: у одной операции может быть несколько распознанных
      // номеров, и все они упрутся в ту же настройку — «сколько платежей пострадало» полезнее, чем
      // «сколько раз портал сказал нет».
      // ⚠ И только те операции, которые в итоге НИКУДА не приземлились. Найдено ревью: у портала
      // может быть две матрицы — рабочая (`СЧ-d+` → инвойс) и сломанная (`ЗАК-d+` → поле, которого
      // нет. Платёж при этом разносится ПРАВИЛЬНО по первой, а счётчик срабатывал бы по второй, и
      // строка лога вместе с пожизненной метрикой утверждали бы «N платежей ушли без привязки» про
      // платежи, которые привязаны. Сломанную матрицу это не скрывает: сообщение в чат всё равно
      // уходит — оно про НАСТРОЙКУ и от исхода конкретной операции не зависит.
      const badConfig = resolutions.find(r => r.status === 'misconfigured')
      if (badConfig) {
        if (candidates.length === 0) misconfigured++
        misconfigReason ??= badConfig.reason ?? ''
        // ⚠ Сообщение шлём ЗДЕСЬ, а не после цикла. Первая редакция копила причину и отправляла в
        // конце — и теряла её насовсем, если позже в той же пачке падала другая операция: джоба
        // умирала, а на повторе эта операция отсеивалась на маркере уже записанного дела и причину
        // никто не пересчитывал. Флаг держит обещание «одно сообщение за прогон».
        if (!settingsNoticeSent && errorChat?.dialogId) {
          settingsNoticeSent = true
          await deps.notifySettingsError(badConfig.reason ?? '', errorChat.dialogId, job.memberId, item.account)
        }
      }
      if (candidates.length === 0 && searched.length > 0) {
        // Номера в назначении распознаны, а подходящей сущности у этого клиента нет: счёт удалён,
        // номер набран с опечаткой, документ в отменённой стадии. Для бухгалтера это неотличимо от
        // нормальной обработки — дело записано, привязки нет, — и расхождение всплывает только при
        // сверке. Поэтому случай считается и уходит в чат ошибок, как остальные «нужен человек».
        unresolved++
        if (errorChat?.dialogId && unresolvedNotices < MAX_UNRESOLVED_NOTICES) {
          // Дедуп по значению: один и тот же номер, совпавший с двумя матрицами разного вида, дал
          // бы две одинаковые строки — в сообщении «ничего не нашли» это читается как две разные
          // проблемы.
          unresolvedIds = [...new Set(searched.map(r => r.value).filter(v => v !== ''))]
          // Проверены не все распознанные номера (кап §4) — говорим об этом прямо, иначе неполный
          // список читается как полный.
          truncatedIntents = intents.length > toResolve.length
          if (unresolvedIds.length > 0) unresolvedNotices++
        }
      }
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
          sample ??= makeProgramSample(item, 'ambiguous')
        } else if (summary.outcome === 'allocatable') {
          allocatable++
        } else if (summary.outcome === 'manual') {
          manual++
          sample ??= makeProgramSample(item, 'manual')
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
          writeOffTargets.push(target)
          const etids = ledgerPaymentRef && ledgerDistributionRef ? { paymentSp: ledgerPaymentRef, distributionSp: ledgerDistributionRef } : null
          // Portal MUTATION (§2) gated on the opt-in `autoDistribute`. The pre-check reads B24 STATE
          // (`isTargetApplied` — payment `paid='Y'` / invoice on the configured paid stage, Фаза A)
          // so a redelivery/reimport never re-pays (and it covers the pay-then-crash window). An
          // unsupported target kind (invoice stage w/o config, trigger — handled below) applies
          // nothing. Runs BEFORE the ledger row, so a thrown REST error leaves no row ⇒ clean retry.
          let applied = false
          if (autoDistribute && !(await deps.isTargetApplied(item, target, job.memberId, { invoicePaidStageId: settings?.allocation?.invoicePaidStageId }))) {
            applied = await deps.applyAllocation(item, target, job.memberId, { invoicePaidStageId: settings?.allocation?.invoicePaidStageId })
          }
          // DURABLE allocation record = the SP-ledger distribution row (§9.3 #6 — Postgres
          // `allocation_fact` retired). Written WHENEVER both SPs are provisioned, INDEPENDENT of
          // `autoDistribute`. Idempotent by marker (a redelivery finds the row → `created:false` →
          // no double-count); a REST error propagates (clean retry). `allocated` counts the fact
          // (the row); `distributed` counts a mutation actually applied THIS run. WITHOUT SP there
          // is no durable per-target fact — op-level idempotency is held by the B24 activity marker
          // (`writeActivity` stamps it; a redelivery is `continue`d at the top gate). Does NOT
          // replace the activity дело. companyId is non-null here (matched-company branch).
          if (etids && deps.writeLedger && companyId) {
            if (await deps.writeLedger(item, target, companyId, job.memberId, etids)) {
              allocated++
              ledgerWritten++
              // `distributed` (mutation applied THIS run) nests under a freshly-created row, so it
              // stays a strict subset of `allocated`; a redelivery (created:false) bumps neither.
              if (applied) distributed++
            }
          } else if (applied) {
            // No SP-ledger: no durable per-target fact (op-level idempotency = the B24 activity
            // marker). The portal mutation still applied, so count it; `allocated` stays 0 here.
            distributed++
          }
        }
        // Trigger targets (#79): a deal/smart-process candidate fires the portal's «деньги
        // пришли» automation trigger UNCONDITIONALLY (not amount-gated) — separate from the
        // amount `allocate` above (its `decision.target` is the amount target only). Gated on
        // the opt-in `autoDistribute` + a configured `triggerCode`. For each DISTINCT trigger
        // target (kind+id): the `seen` Set dedups within this run; the DURABLE dedup is now the
        // dist-СП marker (§9.3 #6 — Postgres `allocation_fact` retired): `hasTriggerFact` checks the
        // ledger row, `writeTriggerFact` records the fire as a ZERO-amount row (marker + audit, no
        // «осталось» impact). `applyTrigger` is BEST-EFFORT (never throws — a trigger signals, it
        // doesn't move money). `allocated`+`distributed` bump together on a fired+recorded trigger.
        // The SP dedup runs ONLY when both SPs are provisioned (the expected default-ON state); when
        // they are NOT, the trigger still fires but has only the SINGLE-SHOT protection below.
        // The trigger is attempted ONCE synchronously here (first processing of the op with a matched
        // company). `writeActivity` below persists the B24 dedup marker regardless of trigger outcome,
        // so a later redelivery/poll is `continue`d at the top gate and never re-reaches this loop.
        // DURABLE RETRY (#79): a MISSED fire (`applyTrigger` → 'retry' — transient error, OR a
        // `triggerCode` set but not yet registered) is handed to `enqueueTriggerRetry` so the «деньги
        // пришли» signal SELF-HEALS with backoff (e.g. once the admin registers the CODE), instead of
        // the prior single-shot loss. 'skip' (demo / malformed CODE) neither fires nor retries. Without
        // Redis (`enqueueTriggerRetry` absent/no-op) it gracefully degrades to the old single-shot.
        // Capture the trigger candidates; the actual fire is deferred past `writeActivity` (C2).
        if (autoDistribute && settings?.allocation?.triggerCode) {
          triggerCandidates = candidates
        }
        // ⚠ Триггер-цели (сделка/смарт-процесс) привязываем НЕЗАВИСИМО от `autoDistribute`: тот
        // гейтит МУТАЦИЮ портала (провести оплату, дёрнуть автоматизацию), а привязка ничего не
        // меняет — она лишь показывает человеку, к чему платёж относится. Ставить её в зависимость
        // от разрешения писать в CRM значило бы прятать связь ровно на тех порталах, где ещё не
        // доверились авто-проведению и потому разбирают платежи руками.
        writeOffTargets.push(...candidates.filter(c => isTriggerTarget(c.kind)))
        // Capture (don't send yet) — the notice is posted after writeActivity stamps the marker,
        // so a redelivery is `continue`d at the top gate before it can re-post (see below).
        if ((summary.outcome === 'ambiguous' || summary.outcome === 'manual') && errorChat?.dialogId) {
          errorNotice = summary.decision
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
      sample ??= makeProgramSample(item, 'unmatched')
      const myCompanyId = await resolveMyCompany(item)
      writeCompanyId = myCompanyId
      if (myCompanyId) note = unmatchedClientNote(item)
    }
    const activityId = await deps.writeActivity(item, writeCompanyId, job.memberId, note)
    // Per-op observation (see `onOperation`): emitted for EVERY op that got this far, including
    // the ones that matched nothing — those are exactly the ones no other callback reports.
    const opOutcome = {
      owner: (companyId ? 'client' : writeCompanyId ? 'my-company' : 'none') as 'client' | 'my-company' | 'none',
      recognized: intents.length,
      activityId
    }
    deps.onOperation?.(item, opOutcome, job.memberId)
    // Count the ops that LANDED (client identified AND an activity written). This is domain
    // bookkeeping rather than a logging detail, which is why it lives here and not in the logger:
    // the run summary uses it to state how many per-op lines were omitted, and a silent omission
    // reads as "there was nothing else" (#498).
    if (landedCleanly(opOutcome)) landed++
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
    // ─── Привязки дела (#579, шаг 3 согласованного процесса) ─────────────────────────────────
    // Дело несёт РОВНО ОДНУ пару владельца, поэтому всё остальное, что человек должен из него
    // достать, привязывается отдельными вызовами: элемент реестра платежей, сущность списания и
    // вторая компания (владельцем стала одна из двух).
    //
    // ⚠ ПОСЛЕ маркера, как и чат-оповещения: до него любой отказ ниже по коду вернул бы джобу на
    // повтор, и привязки ставились бы второй раз — а повторная привязка той же пары у портала
    // ОШИБКА (`ACTIVITY_IS_ALREADY_BOUND`, замерено живым прогоном), то есть шум, неотличимый от
    // настоящего сбоя.
    //
    // ⚠ «Моя компания» ищется и для ОПОЗНАННОГО клиента — иначе связь односторонняя. Поиск
    // запоминается на прогон (`resolveMyCompany`), а зовётся только когда привязки вообще есть
    // кому ставить: на портале без этой возможности лишних трёх вызовов быть не должно.
    if (deps.bindActivity) {
      // ⚠ ВЕСЬ блок под `try`, а не только сам вызов привязок — включая поиск «моей компании».
      // Найдено ревью, и это был настоящий дефект: `findMyCompany` пробрасывает ошибки транспорта
      // (так и задумано на его ПЕРВОМ месте вызова — там он идёт ДО маркера, и бросок означает
      // чистый повтор). Здесь мы зовём его ПОСЛЕ маркера, поэтому транзиентный отказ портала
      // уронил бы всю джобу с уже записанным делом: остаток пачки не обработан, а привязки этой
      // операции потеряны навсегда и даже не посчитаны — повтор упрётся в маркер и пройдёт мимо.
      // ⚠ Поиск «моей компании» — под СВОИМ гардом, и это не перестраховка. Он пробрасывает
      // ошибки транспорта (так задумано на его первом месте вызова — там он идёт ДО маркера, и
      // бросок означает чистый повтор). Здесь мы зовём его ПОСЛЕ маркера, поэтому его отказ не
      // должен ни ронять джобу, ни уносить ОСТАЛЬНЫЕ ссылки: элемент реестра и сущность списания
      // известны и без него. Найдено ревью — прежняя редакция теряла в этом случае все привязки.
      let myCompanyId: string | null = writeCompanyId
      let myCompanyLost = false
      if (!clientUnmatched) {
        try {
          myCompanyId = await resolveMyCompany(item)
        } catch {
          myCompanyId = null
          myCompanyLost = true
        }
      }
      const refs = planActivityBindings({
        owner: companyRef(writeCompanyId),
        // Порядок = важность: потолок отсекает ХВОСТ.
        //
        // ⚠ Сперва то, чего РОВНО ПО ОДНОМУ (элемент реестра и «моя компания»), и лишь затем
        // цели списания, которых бывает много. Обратный порядок выглядел естественнее и был
        // ошибкой: число целей задаёт назначение платежа, то есть ПЛАТЕЛЬЩИК, и пяти
        // распознанных номеров хватало, чтобы вытеснить «мою компанию» — привязку, которую
        // согласованный процесс требует ВСЕГДА. Отказом это не считалось бы и в лог не попало.
        //
        // ⚠ Компании-клиента в списке НЕТ намеренно: когда клиент опознан, он и есть владелец
        // (`writeCompanyId === companyId`), а когда не опознан — `companyId` пуст. То есть эта
        // ссылка не может добавить ничего, кроме дубля владельца.
        refs: [
          ledgerPaymentRef ? itemRef(ledgerPaymentRef.entityTypeId, registryElementId) : null,
          companyRef(myCompanyId),
          ...writeOffTargets.map(allocationTargetRef)
        ]
      })
      // ⚠ Две РАЗНЫЕ потери, и ретраится только одна. Отказ ЗАПИСИ привязок лечится повтором —
      // ссылки известны. Потерянная «моя компания» повтором не лечится: мы не узнали, что именно
      // привязывать, и задача-ретрай молча переставила бы уже стоящие пары.
      let bindFailed = false
      if (refs.length > 0) {
        try {
          const outcome = await deps.bindActivity(activityId, refs, job.memberId)
          if (outcome.failed > 0) bindFailed = true
        } catch {
          // Транспорт обязан не бросать, но контракт держим и здесь: дело уже записано, и падение
          // на связи отменило бы обработку всех оставшихся операций пачки.
          bindFailed = true
        }
        if (bindFailed && deferredQueued < MAX_DEFERRED_WRITES_PER_RUN) {
          // ⚠ Ставим ВЕСЬ список, а не «те, что упали»: транспорт не говорит, какие именно, а
          // воркер всё равно читает `binding.list` и ставит только недостающее. Повторная
          // привязка той же пары — ошибка портала, поэтому слепой повтор был бы хуже отсутствия
          // ретрая.
          deferredQueued++
          await queueDeferredWrite(deps.enqueueBindRetry
            && (() => deps.enqueueBindRetry!(activityId, refs, job.memberId)))
        }
      }
      // ⚠ Считаем ОПЕРАЦИИ, а не отдельные привязки, — как и `registryFailed` рядом. Иначе числа в
      // одной строке итога измеряют разное: у одной операции привязок до `MAX_ACTIVITY_BINDINGS`.
      //
      // ⚠ Потерянная «моя компания» считается тоже: ссылку мы не узнали, ретраить нечего, и
      // молчание тут означало бы, что односторонняя связь выглядит как полная.
      if (bindFailed || myCompanyLost) bindingsFailed++
    }
    // Dedup is atomic now (#259): the ORIGINATOR_ID/ORIGIN_ID marker is written INSIDE
    // writeActivity (todo.add + marker update, #495), so a redelivery's getActivityId finds it — no separate
    // remember step, and no write→remember gap to lose.
    // Error-chat notice (ambiguous/manual allocation), deferred from the allocation block so it
    // sits AFTER the marker write: a redelivery is `continue`d at the top gate before reaching
    // here, so it can't re-post (im.message.add has no dedup — same protection as notifyChat).
    if (errorNotice && errorChat?.dialogId) {
      await deps.notifyError(item, errorNotice, errorChat.dialogId, job.memberId)
    }
    if (unresolvedIds.length > 0 && errorChat?.dialogId) {
      await deps.notifyUnresolved(item, unresolvedIds, errorChat.dialogId, job.memberId, truncatedIntents)
    }
    // Trigger fire (#79), DEFERRED past the marker write (C2). Now that `writeActivity` has stamped
    // the B24 dedup marker, any job retry is `continue`d at the top gate before reaching here — so a
    // no-SP-ledger fire can't double even if a LATER step throws. `companyId` is non-null whenever
    // `triggerCandidates` is populated (it is only set inside the matched-company block). The SP
    // `hasTriggerFact`/`writeTriggerFact` still dedup across redeliveries when SPs are provisioned.
    const triggerCode = settings?.allocation?.triggerCode
    if (companyId && triggerCode && triggerCandidates.length > 0) {
      const seen = new Set<string>()
      for (const t of triggerCandidates) {
        if (!isTriggerTarget(t.kind)) continue
        const targetKey = `${t.kind}:${t.id}` // not the op dedupKey — distinct trigger target
        if (seen.has(targetKey)) continue
        seen.add(targetKey)
        const etids = ledgerPaymentRef && ledgerDistributionRef ? { paymentSp: ledgerPaymentRef, distributionSp: ledgerDistributionRef } : null
        if (etids && deps.hasTriggerFact && await deps.hasTriggerFact(item, t, job.memberId, etids)) continue
        const outcome = await deps.applyTrigger(item, t, job.memberId, triggerCode)
        if (outcome === 'retry') {
          // Durable retry (#79) — best-effort; never fails the batch (a trigger only signals).
          if (deps.enqueueTriggerRetry) await deps.enqueueTriggerRetry(item, t, job.memberId, triggerCode)
          continue
        }
        if (outcome !== 'fired') continue // 'skip' — demo / malformed CODE
        // Record the fire durably in the SP-ledger (when provisioned). Absent SP ⇒ no durable
        // record; count the fire (the marker above guards against re-fire across redeliveries).
        const recorded = etids && deps.writeTriggerFact ? await deps.writeTriggerFact(item, t, companyId, job.memberId, etids) : true
        if (recorded) {
          allocated++
          distributed++
        }
      }
    }
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
  return { processed: unique.length, landed, created, notified, skipped, excluded, registryFailed, bindingsFailed, unmatched, unresolved, misconfigured, recognized, resolved, allocatable, ambiguous, manual, allocated, distributed, ledgerWritten, credits: credits.length, debits: debits.length, ...(misconfigReason !== undefined ? { misconfigReason } : {}), ...(sample ? { sample } : {}) }
}
