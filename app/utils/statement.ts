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
 *
 * ⚠ Empty `docId` is NOT collapsed to `account|`. Some providers/formats leave the document id
 * blank (the normalizers already fall back `DocID → OperationID → Num|DocDate`, but that too can
 * come out empty). If every blank-docId operation shared the key `account|`, the within-batch
 * dedup and the B24 marker lookup would both treat them as ONE payment — silently dropping every
 * operation of that account after the first. So a blank docId falls back to a content signature
 * (amount, currency, date, direction, purpose, counterparty account) — distinct payments stay
 * distinct while a re-run of the SAME payment still yields the SAME key (idempotency holds). Two
 * genuinely identical same-day payments with no doc id still collapse — unavoidable when the bank
 * gives nothing to tell them apart, and far rarer than the account-wide collapse this prevents.
 *
 * The signature is HASHED (fnv-1a 64-bit, fixed 16 hex chars), not concatenated raw: the key
 * becomes the B24 activity ORIGIN_ID (varchar(255)) and the SP-ledger marker — an unbounded
 * payer-controlled purpose would silently truncate there, and the exact-match marker lookup
 * (`findActivityByMarker`) would then never find it, re-creating the activity on every redelivery.
 * Fields are length-prefixed before hashing, so a payer-controlled `¦` can't splice two different
 * operations into one signature. Pure JS (BigInt) — `dedupKey` also runs in the browser preview.
 */
export function dedupKey(
  item: Pick<StatementItem, 'account' | 'docId'>
    & Partial<Pick<StatementItem, 'amount' | 'currency' | 'acceptDate' | 'direction' | 'purpose' | 'counterparty'>>
): string {
  const docId = (item.docId ?? '').trim()
  if (docId) return `${item.account}|${docId}`
  const sig = [item.amount, item.currency, item.acceptDate, item.direction, item.purpose, item.counterparty?.account]
    .map(v => String(v ?? '').trim())
    .map(v => `${v.length}:${v}`) // length-prefix — no field-boundary splicing via crafted content
    .join('')
  return `${item.account}|~sig:${fnv1a64Hex(sig)}`
}

/** FNV-1a 64-bit over UTF-16 code units, as 16 hex chars. Deterministic, dependency-free and
 *  browser-safe (no node:crypto) — used only to bound the blank-docId dedup signature. */
function fnv1a64Hex(s: string): string {
  const PRIME = 0x100000001B3n
  const MASK = 0xFFFFFFFFFFFFFFFFn
  let h = 0xCBF29CE484222325n
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i))
    h = (h * PRIME) & MASK
  }
  return h.toString(16).padStart(16, '0')
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
  /**
   * COUNTERPARTY account numbers whose operations are EXCLUDED from processing entirely (#562).
   *
   * ⚠ Отдельное поле, а не расширение `excludeAccounts`, и это несущее: `excludeAccounts` матчит
   * `item.account` — НАШ счёт («Our own account number…» в типе), то есть выключает счёт целиком.
   * Здесь же выключается ПЛАТЕЛЬЩИК: налоговая, банк с его комиссиями, эквайринг — контрагенты,
   * которых в CRM не будет ни при каком развитии событий, а дела от них затапливают карточку
   * «моей компании» (замерено: 500 дел за шесть суток, все — фолбэк). Смешение двух списков в
   * одном поле означало бы, что номер, вписанный «выключить плательщика», однажды совпадёт с
   * нашим счётом и молча выключит весь его поток.
   */
  excludeCounterpartyAccounts?: string[]
}

/**
 * Whether an operation is EXCLUDED from processing entirely (PROCESSING.md §2 A2): its
 * account is listed in `excludeAccounts`, or its `purpose` contains an
 * `excludePurposePatterns` substring (case-insensitive). An excluded op is skipped whole —
 * NO CRM activity, NO allocation, NO chat. This is stronger than the chat `directions`
 * filter, which only silences the announcement. Pure.
 */
export function isExcludedOperation(
  item: Pick<StatementItem, 'account' | 'purpose'> & { counterparty?: Pick<StatementItem['counterparty'], 'account'> },
  rules: ChatNotifyRules = {}
): boolean {
  // Guard the empty entry symmetrically with excludePurposePatterns below: a blank list entry
  // must never match (e.g. a whitespace-only account matching a blank item.account).
  if (rules.excludeAccounts?.some(acc => acc.trim() !== '' && acc.trim() === item.account.trim())) return true
  // Счёт КОНТРАГЕНТА (#562). Сравнение точное, как у нашего счёта: «похожий» номер — другой номер.
  // ⚠ Пустой счёт контрагента не матчится никогда — иначе пустая строка в правиле выключила бы
  // все операции, у которых банк не сообщил счёт плательщика.
  const cp = (item.counterparty?.account ?? '').trim()
  if (cp !== '' && rules.excludeCounterpartyAccounts?.some(acc => acc.trim() === cp)) return true
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
