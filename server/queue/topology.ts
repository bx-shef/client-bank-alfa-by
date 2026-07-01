// Queue topology for the BullMQ/Redis pipeline — pure contracts (names, payloads,
// idempotent job ids), no Redis/BullMQ import, so it is fully unit-testable.
//
// Three queues carry the three kinds of work the backend does under load:
//   b24-events — follow-up work after a verified B24 event (install → seed fetch);
//   bank-fetch — pull a statement window for one portal/account (Alfa/Prior);
//   file-parse — parse an uploaded client-bank file (manual import).
//
// Job ids are deterministic so BullMQ deduplicates natural retries: re-enqueuing
// the same fetch window / same file / same event does not create a duplicate job.
// Business processing (the workers) lands with stages 4–6 — see docs/REFACTOR_PLAN.md.

import type { BankProviderId } from '../../app/types/statement'

export const Q_EVENTS = 'b24-events'
export const Q_FETCH = 'bank-fetch'
export const Q_PARSE = 'file-parse'

/** All queue names, for wiring workers/monitoring. */
export const QUEUE_NAMES = [Q_EVENTS, Q_FETCH, Q_PARSE] as const
export type QueueName = typeof QUEUE_NAMES[number]

/** Follow-up work after a verified B24 event (token save stays synchronous). */
export interface EventJob {
  memberId: string
  domain: string
  kind: 'ONAPPINSTALL' | 'ONAPPUNINSTALL'
  /** Event timestamp from B24 (deduplicates redelivery of the same event). */
  ts: string
}

/** Pull one statement window for a portal/account (the cron fans these out). */
export interface FetchJob {
  memberId: string
  providerId: BankProviderId
  account: string
  /** ISO date range (inclusive) for the statement window. */
  dateFrom: string
  dateTo: string
}

/** Parse one uploaded client-bank file (manual import). `fileHash` dedups reuploads. */
export interface ParseJob {
  memberId: string
  providerId: BankProviderId
  /** Storage key/reference of the uploaded file (not the bytes). */
  fileRef: string
  /** Content hash — same file re-uploaded → same job id → no duplicate parse. */
  fileHash: string
}

/** Colon-join id parts, encoding each so a value containing ':' can't collide. */
function joinId(parts: (string | number)[]): string {
  return parts.map(p => encodeURIComponent(String(p))).join(':')
}

export function eventJobId(job: EventJob): string {
  return joinId(['evt', job.memberId, job.kind, job.ts])
}

export function fetchJobId(job: FetchJob): string {
  return joinId(['fetch', job.memberId, job.providerId, job.account, job.dateFrom, job.dateTo])
}

export function parseJobId(job: ParseJob): string {
  return joinId(['parse', job.memberId, job.fileHash])
}
