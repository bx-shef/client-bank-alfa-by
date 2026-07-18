import type { OperationDirection, StatementItem } from '~/types/statement'

// Pure statement logic — income/expense classification, idempotency key, and
// the chat-notification filter. No I/O; fully unit-tested and reusable by the
// backend poller.

/**
 * Map Alfa's raw operation type to our direction (`C`redit / everything else =
 * `debit`). Alfa-specific; other providers (Prior, manual) supply their own
 * mapping. Unknown/empty values fall back to `debit` by design.
 */
export function directionFromOperType(operType: string | undefined): OperationDirection {
  return (operType ?? '').trim().toUpperCase() === 'C' ? 'credit' : 'debit'
}

/**
 * Stable idempotency key for one operation: `account|docId`. Used to avoid
 * creating duplicate CRM activities / chat messages for the same payment.
 */
export function dedupKey(item: Pick<StatementItem, 'account' | 'docId'>): string {
  return `${item.account}|${item.docId}`
}

/** Split items into incoming (credit) and outgoing (debit) buckets. */
export function splitByDirection(items: readonly StatementItem[]): {
  credits: StatementItem[]
  debits: StatementItem[]
} {
  const credits: StatementItem[] = []
  const debits: StatementItem[] = []
  for (const item of items) {
    (item.direction === 'credit' ? credits : debits).push(item)
  }
  return { credits, debits }
}

/** Rules controlling which operations are processed and announced.
 *  Two DIFFERENT scopes live here (PROCESSING.md §2 A2):
 *  - `excludeAccounts` / `excludePurposePatterns` — a **processing** exclusion: a matching
 *    operation is skipped ENTIRELY (no CRM activity, no allocation, no chat). See
 *    `isExcludedOperation`.
 *  - `directions` — a **chat-only** filter: an op of a non-announced direction is still
 *    written to CRM, just not announced. See `shouldNotifyChat`. */
export interface ChatNotifyRules {
  /** Directions to announce in chat. Default: only `credit` (приходы). An empty array
   * announces nothing (but ops are still written to CRM — this is chat-only). */
  directions?: OperationDirection[]
  /** Account numbers to EXCLUDE from processing entirely (not just chat). */
  excludeAccounts?: string[]
  /** Case-insensitive `purpose` substrings that EXCLUDE the op from processing entirely. */
  excludePurposePatterns?: string[]
}

/**
 * Whether an operation is EXCLUDED from processing entirely (PROCESSING.md §2 A2): its
 * account is listed in `excludeAccounts`, or its `purpose` contains an
 * `excludePurposePatterns` substring (case-insensitive). An excluded op is skipped whole —
 * NO CRM activity, NO allocation, NO chat. This is stronger than the chat `directions`
 * filter, which only silences the announcement. Pure.
 */
export function isExcludedOperation(item: Pick<StatementItem, 'account' | 'purpose'>, rules: ChatNotifyRules = {}): boolean {
  // Guard the empty entry symmetrically with excludePurposePatterns below: a blank list entry
  // must never match (e.g. a whitespace-only account matching a blank item.account).
  if (rules.excludeAccounts?.some(acc => acc.trim() !== '' && acc.trim() === item.account.trim())) return true
  const purpose = item.purpose.toLowerCase()
  return rules.excludePurposePatterns?.some(p => p.trim() !== '' && purpose.includes(p.toLowerCase())) ?? false
}

/** Split a textarea value into a clean list: one item per line, trimmed, no
 * blanks or duplicates. Used to edit `excludeAccounts`/`excludePurposePatterns`. */
export function parseRuleLines(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line) seen.add(line)
  }
  return [...seen]
}

const DEFAULT_DIRECTIONS: OperationDirection[] = ['credit']

/**
 * Whether an operation should be announced to the chat, given the rules.
 * Defaults to "announce credits only". An item is silenced when its direction
 * is not allowed OR it is an excluded operation (`isExcludedOperation`). Note an
 * excluded op never reaches this check in crm-sync (it's skipped whole earlier) — the
 * exclusion is repeated here so the settings preview and any direct caller stay correct.
 */
export function shouldNotifyChat(item: StatementItem, rules: ChatNotifyRules = {}): boolean {
  const directions = rules.directions ?? DEFAULT_DIRECTIONS
  if (!directions.includes(item.direction)) return false
  return !isExcludedOperation(item, rules)
}
