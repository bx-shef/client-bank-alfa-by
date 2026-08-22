// Queue topology for the BullMQ/Redis pipeline — pure contracts (names, payloads,
// idempotent job ids), no Redis/BullMQ import, so it is fully unit-testable.
//
// Four queues carry the pipeline the backend runs under load:
//   b24-events — follow-up work after a verified B24 event (install/uninstall);
//   bank-fetch — pull a statement window for one portal/account (Alfa/Prior);
//   file-parse — parse an uploaded client-bank file (manual import);
//   crm-sync   — analyse normalized operations and act in Bitrix24 (find company,
//                write a universal activity, notify chat). Both bank-fetch and
//                file-parse feed their normalized StatementItem[] into this queue.
//
// Job ids are deterministic so BullMQ deduplicates natural retries: re-enqueuing
// the same fetch window / same file / same batch does not create a duplicate job.

import type { BankProviderId, StatementItem } from '../../app/types/statement'
import type { IssuePayload } from '../../app/utils/feedback'
import type { AllocationTargetKind } from '../../app/utils/allocation'
import type { SpRef } from '../../app/config/distributionSp'

export const Q_EVENTS = 'b24-events'
export const Q_FETCH = 'bank-fetch'
/**
 * Prior's bank-fetch queue — SEPARATE from `bank-fetch` because a Prior job is nothing like an
 * Alfa one, and mixing them breaks both fairness and the rate cap:
 *  - COST: Alfa is one GET (sub-second, 1 bank request); Prior's async create+poll is an accounts
 *    resolve + a create + up to 8 polls (~10 requests, up to minutes). A single queue's limiter
 *    counts JOBS, so Prior traffic would be undercounted ~10× against a cap sized for Alfa.
 *  - FAIRNESS: `bank-fetch` runs at QUEUE_CONCURRENCY (default 1), so one slow Prior job would
 *    head-of-line block every other portal's fetches — Alfa included.
 * Two queues give each provider its own Redis-backed limiter and its own worker slots, so neither
 * can starve or over-spend the other. `bank-fetch` KEEPS its name on purpose: renaming it would
 * strand the jobs already queued in Redis at deploy time.
 */
export const Q_FETCH_PRIOR = 'bank-fetch-prior'
export const Q_PARSE = 'file-parse'
export const Q_CRM = 'crm-sync'
export const Q_DELETIONS = 'b24-deletions'
export const Q_FEEDBACK = 'feedback-post'
export const Q_TRIGGER = 'trigger-fire'
/**
 * Долговременный ретрай ЗАПИСИ В РЕЕСТР платежей (#578) и ПРИВЯЗОК дела (#585).
 *
 * ⚠ Очереди ДВЕ, а не одна общая «дозапись в CRM», хотя болезнь у них одна. Разное всё, что важно
 * для очереди: payload реестра несёт операцию выписки (финансовые ПДн ⇒ ограниченное по возрасту
 * удержание, #245), payload привязок — только id сущностей CRM; у реестра ретрай лечит отказ
 * записи, у привязок — ещё и частично применённый батч. Общая очередь заставила бы каждого
 * потребителя разбирать вид задачи, а бюджет простоя (`queueAlert`) стал бы средним по больнице.
 */
export const Q_REGISTRY = 'registry-write'
export const Q_BINDINGS = 'activity-bind'

/** All queue names, for wiring workers/monitoring. */
export const QUEUE_NAMES = [Q_EVENTS, Q_FETCH, Q_FETCH_PRIOR, Q_PARSE, Q_CRM, Q_DELETIONS, Q_FEEDBACK, Q_TRIGGER, Q_REGISTRY, Q_BINDINGS] as const
export type QueueName = typeof QUEUE_NAMES[number]

/** Portal credentials to persist on register (ONAPPINSTALL). `refreshTokenEnc` is
 *  the AES-GCM blob (secretCrypto) — the refresh token is NEVER carried in clear
 *  through Redis. The webhook endpoint encrypts it; the consumer decrypts + stores. */
export interface EventJobCredentials {
  accessToken: string
  refreshTokenEnc: string
  /** Absolute epoch ms when the access token expires (stamped at receipt). */
  expiresAt: number
  applicationToken: string
}

/**
 * A verified B24 event to APPLY to the store. The webhook endpoint only verifies
 * and enqueues (it never writes the DB); the consumer registers or unregisters the
 * portal. `credentials` is present on ONAPPINSTALL (what to persist), absent on
 * ONAPPUNINSTALL (which always removes everything for the portal).
 */
export interface EventJob {
  memberId: string
  domain: string
  kind: 'ONAPPINSTALL' | 'ONAPPUNINSTALL'
  /** Event timestamp from B24 (deduplicates redelivery of the same event). */
  ts: string
  /** Present on ONAPPINSTALL — the portal credentials the consumer persists. */
  credentials?: EventJobCredentials
}

/** Pull one statement window for a portal/account (the cron fans these out). */
export interface FetchJob {
  memberId: string
  providerId: BankProviderId
  account: string
  /** ISO date range (inclusive) for the statement window. */
  dateFrom: string
  dateTo: string
  /** Per-tick token (real polling, A10). Part of `fetchJobId` ONLY — the bank query
   *  ignores it — so each poll of the same account/window is a DISTINCT job that actually
   *  re-fetches (otherwise the deterministic id + removeOnComplete retention would dedupe
   *  every same-day re-poll into a no-op). Re-emitting identical ops is safe: crm-sync
   *  dedupes by the B24 activity marker. Absent for demo/manual jobs (ids unchanged). */
  epoch?: string
}

/** Parse one uploaded client-bank file (manual import). `fileHash` dedups reuploads.
 *  The file rides IN the packet as base64 (`contentBase64`) — statement exports are
 *  small (≤ MAX_UPLOAD_BYTES, 2 МБ), so we don't need a separate file store; the
 *  worker decodes windows-1251 and parses. `userId` is the B24 user who uploaded
 *  (attribution / logging). */
export interface ParseJob {
  memberId: string
  providerId: BankProviderId
  /** Original file name (logging / result display). */
  fileName: string
  /** File bytes (windows-1251), base64-encoded — rides in the packet, no file store. */
  contentBase64: string
  /** Content hash — same file re-uploaded → same job id → no duplicate parse. */
  fileHash: string
  /** B24 user id who initiated the import (attribution; resolved server-side). */
  userId?: string
}

/** Analyse normalized operations and act in Bitrix24. `batchId` (the producing
 *  fetch window / file hash) makes the job idempotent — the same batch dedups.
 *
 *  KNOWN LIMITATION (stages 4–5): `items` is carried inline in the Redis payload.
 *  Fine for the demo (a couple of ops), but a large statement/file could bloat
 *  Redis and the worker↔Redis transfer. Before real fetch/parse lands, switch to a
 *  referenced payload (batchId + fetch items from Postgres) or chunk the batch. */
export interface CrmSyncJob {
  memberId: string
  providerId: BankProviderId
  /** Where the batch came from — for logging/metrics. */
  source: 'fetch' | 'parse'
  /** Stable id of the producing batch (fetch window or file hash). */
  batchId: string
  /** Normalized operations to analyse and write into CRM (see limitation above). */
  items: StatementItem[]
}

/**
 * A verified CRM DELETION event to reconcile against the SP-ledger (#109, §9.2). The webhook
 * verifies `application_token` and enqueues the RAW event fields; the consumer loads the portal's
 * SP config (settings), classifies the entity kind, and reconciles (recompute «осталось» /
 * deactivate ledger rows / error chat). Carries the minimum (id + raw entityTypeId + code) — NO
 * amounts/accounts (privacy, §9.2). `domain` lets the consumer act as the portal.
 */
export interface DeletionJob {
  memberId: string
  domain: string
  /** The raw B24 event code (e.g. `ONCRMDEALDELETE`) — classified by the consumer with SP config. */
  eventCode: string
  /** The deleted entity id (digit string, validated at ingestion). */
  entityId: string
  /** Raw ENTITY_TYPE_ID for a dynamic-item deletion (absent for deal/company events). */
  entityTypeId?: number
  /** Event timestamp from B24 (deduplicates redelivery of the same deletion). */
  ts: string
}

/**
 * A feedback GitHub issue to (re)post — the DURABLE OUTBOX for the «сотрудник» channel (#61). The
 * route builds + SANITIZES the issue synchronously (auth, Trojan-Source strip, HTML-escape — see
 * app/utils/feedback.ts) and posts it directly; only a TRANSIENT GitHub failure (5xx/429/network)
 * is handed to this queue so the post survives a blip / the employee closing the tab. The payload is
 * the already-built `IssuePayload` (no raw untrusted input re-enters here) + the portal + rating kind
 * (for the #195 metric on eventual success). `contentHash` dedups a double-submitted identical issue.
 * NB: the receiving repo is PRIVATE (feedbackConfig fail-closed), so an attached statement excerpt
 * in the body is permitted — but treat this payload as PII-bearing for retention (age-bound).
 */
export interface FeedbackPostJob {
  memberId: string
  kind: 'up' | 'down'
  /** The built, sanitized GitHub issue (title/body/labels). */
  payload: IssuePayload
  /** Stable hash of the payload — dedups an identical re-submission. */
  contentHash: string
}

/**
 * A payment-automation TRIGGER to (re)fire — the DURABLE RETRY for the «деньги пришли» signal (#79).
 * crm-sync fires the trigger ONCE synchronously; if that attempt misses (transient token/network/limit
 * error, OR a `triggerCode` that is set but **not yet registered** on the portal), it enqueues this job
 * so the signal SELF-HEALS: the worker re-fires with backoff until the portal confirms `{result:true}`
 * (e.g. once the admin registers the CODE) or the attempts exhaust. A trigger only SIGNALS (it moves no
 * money), so a redelivered double-fire is a benign double-signal. Carries no amount/counterparty/purpose —
 * only the target ids, the app's own CODE, and `opKey` (`account|docId`, which embeds an account number,
 * as `fetchJobId` already does) — and it makes distinct payments to the same target distinct jobs (each
 * payment is its own signal).
 */
export interface TriggerFireJob {
  memberId: string
  /** The app's canonical automation-trigger CODE (from settings `allocation.triggerCode`). */
  triggerCode: string
  /** Trigger target kind — only `deal` / `smart-process` fire triggers (amount targets don't). */
  targetKind: AllocationTargetKind
  /** Target entity id (positive integer string). */
  targetId: string
  /** Portal-specific `entityTypeId` for a smart-process target → OWNER_TYPE_ID (absent for a deal). */
  targetEntityTypeId?: number
  /** The producing operation's dedup key (`account|docId`) — distinguishes two payments to one target. */
  opKey: string
}

/**
 * Запись элемента реестра платежей, не удавшаяся синхронно (#578).
 *
 * ⚠ Несёт САМУ ОПЕРАЦИЮ выписки — иначе колонки реестра неоткуда взять. Это финансовые ПДн, как и
 * в `crm-sync`, поэтому удержание задачи ограничено по ВОЗРАСТУ (#245), а не по числу.
 *
 * ⚠ `companyId` — это КЛИЕНТ (или `null`), а не «моя компания»: элемент связывает плательщика, и
 * подстановка фолбэка пометила бы чужой платёж как свой собственный.
 */
export interface RegistryWriteJob {
  memberId: string
  providerId: BankProviderId
  /** Операция выписки — источник всех восьми колонок реестра. */
  item: StatementItem
  /** id компании-плательщика в CRM, если она опознана. */
  companyId: string | null
  /** Смарт-процесс «Платежи» портала на момент постановки задачи. */
  paymentSp: SpRef
}

/**
 * Привязки дела, не вставшие синхронно (#585).
 *
 * ⚠ Payload НЕ содержит ПДн: только id дела и пары «тип сущности + id» внутри CRM клиента. Поэтому
 * удержание здесь обычное, а не ограниченное возрастом.
 */
export interface ActivityBindJob {
  memberId: string
  /** id дела, к которому привязываем. */
  activityId: string
  /** Пары, которые должны стоять на деле. Уже стоящие воркер пропустит, прочитав `binding.list`. */
  refs: Array<{ entityTypeId: number, entityId: number }>
}

// Separator for job-id parts. BullMQ FORBIDS ':' in a custom job id (it namespaces
// its Redis keys with ':', so a custom id containing ':' throws "Custom Id cannot
// contain :"). We join with '|', which encodeURIComponent escapes (%7C) — so no
// encoded part can contain a literal '|', keeping ids collision-free AND BullMQ-safe.
const ID_SEP = '|'

/** Join id parts, encoding each so a value containing the separator can't collide. */
function joinId(parts: (string | number)[]): string {
  return parts.map(p => encodeURIComponent(String(p))).join(ID_SEP)
}

export function eventJobId(job: EventJob): string {
  return joinId(['evt', job.memberId, job.kind, job.ts])
}

export function fetchJobId(job: FetchJob): string {
  const base = ['fetch', job.memberId, job.providerId, job.account, job.dateFrom, job.dateTo]
  // Append the epoch segment only when present, so existing demo/manual ids stay byte-identical.
  return joinId(job.epoch ? [...base, job.epoch] : base)
}

/** Which fetch queue a job belongs to — Prior's multi-request create+poll gets its own queue
 *  (own limiter + own worker slots); everything else (Alfa, demo, manual) stays on `bank-fetch`
 *  so its already-queued jobs are undisturbed. Pure — the single source of the routing, shared by
 *  the producer and the workers so they can never drift onto different queues. */
export function fetchQueueFor(providerId: BankProviderId): typeof Q_FETCH | typeof Q_FETCH_PRIOR {
  return providerId === 'prior-by' ? Q_FETCH_PRIOR : Q_FETCH
}

export function parseJobId(job: ParseJob): string {
  return joinId(['parse', job.memberId, job.fileHash])
}

export function crmSyncJobId(job: CrmSyncJob): string {
  return joinId(['crm', job.memberId, job.batchId])
}

export function deletionJobId(job: DeletionJob): string {
  // member|event|id|ts (§9.2) — a redelivered deletion of the same entity dedups.
  return joinId(['del', job.memberId, job.eventCode, job.entityId, job.ts])
}

export function feedbackPostJobId(job: FeedbackPostJob): string {
  // member|hash (#61) — the same built issue (double-submit / redelivery) dedups to one job.
  return joinId(['fb', job.memberId, job.contentHash])
}

export function registryWriteJobId(job: RegistryWriteJob): string {
  // member|opKey (#578) — одна операция, один элемент реестра. Повторная постановка той же
  // операции дедуплицируется: сама запись идемпотентна по маркеру.
  return joinId(['reg', job.memberId, `${job.item.account}|${job.item.docId}`])
}

export function activityBindJobId(job: ActivityBindJob): string {
  // member|activityId (#585) — привязки принадлежат ОДНОМУ делу, и повторная постановка для того
  // же дела это та же работа, а не вторая.
  return joinId(['bind', job.memberId, job.activityId])
}

export function triggerFireJobId(job: TriggerFireJob): string {
  // member|opKey|kind|id (#79) — one payment→target signal; a re-enqueue of the SAME
  // (payment, target) dedups, while a different payment to the same target is a distinct job.
  return joinId(['trg', job.memberId, job.opKey, job.targetKind, job.targetId])
}
