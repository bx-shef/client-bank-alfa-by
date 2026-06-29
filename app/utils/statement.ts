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

/** Rules controlling which operations are announced to the chat. */
export interface ChatNotifyRules {
  /** Directions to announce. Default: only `credit` (приходы). An empty array
   * suppresses all notifications. */
  directions?: OperationDirection[]
  /** Our own account numbers to stay silent about. */
  excludeAccounts?: string[]
  /** Case-insensitive substrings in `purpose` that suppress the announcement. */
  excludePurposePatterns?: string[]
}

const DEFAULT_DIRECTIONS: OperationDirection[] = ['credit']

/**
 * Whether an operation should be announced to the chat, given the rules.
 * Defaults to "announce credits only". An item is silenced when its direction
 * is not allowed, its account is excluded, or its purpose matches an exclude
 * pattern.
 */
export function shouldNotifyChat(item: StatementItem, rules: ChatNotifyRules = {}): boolean {
  const directions = rules.directions ?? DEFAULT_DIRECTIONS
  if (!directions.includes(item.direction)) return false

  if (rules.excludeAccounts?.some(acc => acc.trim() === item.account.trim())) return false

  const purpose = item.purpose.toLowerCase()
  if (rules.excludePurposePatterns?.some(p => p.trim() !== '' && purpose.includes(p.toLowerCase()))) {
    return false
  }

  return true
}
