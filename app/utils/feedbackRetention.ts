// Retention for the private feedback repo (#284). The receiving repo (GITHUB_FEEDBACK_REPO)
// accumulates REAL client statements — financial PII (accounts / amounts / УНП / company names /
// portal member_id), embedded in an issue's body under the employee's consent (#198) or, for the
// program `format` channel, the whole file that failed to parse. PII must not be kept forever, so a
// scheduled sweep (scripts/feedback-retention.mjs) REDACTS the statement block out of CLOSED issues
// that have aged past the retention window, leaving the (non-PII) triage metadata intact.
//
// This module is the PURE core (no network): the retention period, the "is this issue purgeable?"
// decision, and the body redaction — all unit-tested. The script is the I/O shell that lists issues
// and PATCHes the redacted bodies.

import { FILE_EMBED_SUMMARY } from './feedback'

/** Default retention window (days) for statement PII in the private feedback repo. A closed issue is
 *  redacted once its `closed_at` is older than this. Kept modest — long enough for triage/repro, short
 *  enough to honor PII hygiene. Overridable via the FEEDBACK_RETENTION_DAYS env in the sweep script. */
export const FEEDBACK_RETENTION_DAYS = 30

/** Clamp a retention-days value to a sane range: reject blank/non-finite/≤0 → default; cap at 365 so a
 *  fat-fingered env can't disable retention entirely. Mirrors resolveTombstoneDays (#77). */
export function resolveRetentionDays(raw: string | number | undefined): number {
  if (raw === undefined || raw === '') return FEEDBACK_RETENTION_DAYS
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return FEEDBACK_RETENTION_DAYS
  return Math.min(Math.floor(n), 365)
}

/** Marker written in place of a redacted statement block, so a re-run is idempotent (the block is
 *  gone → nothing left to redact) and a human reading the issue sees why the content is absent. */
export const REDACTION_MARKER = '_[выписка удалена по retention-политике (#284)]_'

// Matches the collapsed statement block emitted by `fileEmbedLines` (feedback.ts):
//   <details><summary>Показать содержимое</summary> … </details>
// Non-greedy body, case-sensitive, multi-block (`g`) — an issue could carry more than one embed.
// `[\s\S]` so it spans newlines. The summary marker is the shared FILE_EMBED_SUMMARY constant, so
// the writer and this redactor can't drift. We escape it defensively though it has no regex metachars.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
const STATEMENT_BLOCK_RE = new RegExp(
  `<details><summary>${escapeRe(FILE_EMBED_SUMMARY)}</summary>[\\s\\S]*?</details>`,
  'g'
)

/**
 * Redact every embedded statement block from an issue body, replacing each with a short marker.
 * Returns the new body and whether anything changed (so the caller skips a no-op PATCH). Idempotent:
 * a body already redacted (no blocks) returns `{ changed: false }`.
 */
export function redactStatementBlocks(body: string): { body: string, changed: boolean } {
  if (!body.includes(`<summary>${FILE_EMBED_SUMMARY}</summary>`)) return { body, changed: false }
  const next = body.replace(STATEMENT_BLOCK_RE, REDACTION_MARKER)
  return { body: next, changed: next !== body }
}

/** True if a body still carries at least one un-redacted statement block. Uses `.match()` (not
 *  `.test()`): the shared regex is global, and `.test()` would advance its `lastIndex` and flip
 *  results across calls; `.match()` with a `/g` regex is stateless. */
export function hasStatementBlock(body: string): boolean {
  return body.match(STATEMENT_BLOCK_RE) !== null
}

/** Minimal shape of a GitHub issue the retention decision needs (subset of the REST payload). */
export interface RetentionIssue {
  number: number
  /** 'open' | 'closed'. Only closed (triaged) issues are purged. */
  state: string
  /** ISO timestamp the issue was closed, or null/absent when still open. */
  closed_at?: string | null
  /** Issue body (may embed a statement block). */
  body?: string | null
}

/**
 * Decide whether an issue is due for statement redaction: it must be CLOSED, its `closed_at` must be
 * older than the retention window, and its body must still carry an un-redacted statement block
 * (already-redacted / never-had-one issues are skipped, so a re-run is a no-op). `now` and
 * `retentionDays` are injected — pure and testable.
 */
export function isPurgeable(issue: RetentionIssue, now: number, retentionDays: number): boolean {
  if (issue.state !== 'closed') return false
  if (!issue.closed_at) return false
  const closedMs = Date.parse(issue.closed_at)
  if (!Number.isFinite(closedMs)) return false
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  if (closedMs > cutoff) return false
  return hasStatementBlock(issue.body ?? '')
}

/** Plan the redactions for a batch of issues: the purgeable ones with their redacted bodies. Pure. */
export function planRetention(
  issues: RetentionIssue[],
  now: number,
  retentionDays: number
): Array<{ number: number, body: string }> {
  const out: Array<{ number: number, body: string }> = []
  for (const issue of issues) {
    if (!isPurgeable(issue, now, retentionDays)) continue
    const { body, changed } = redactStatementBlocks(issue.body ?? '')
    if (changed) out.push({ number: issue.number, body })
  }
  return out
}
