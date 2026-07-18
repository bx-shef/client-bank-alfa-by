// Pure aggregation of a normalized StatementItem[] into the numbers the employee
// import-result view animates (#62): headline count, income/expense totals PER CURRENCY,
// and an income-vs-expense breakdown BY DAY for the charts. No DOM, no ECharts — just data,
// so it is unit-testable and shared by both import paths (manual upload + online poll).
//
// MULTI-CURRENCY. Statement amounts across currencies are NOT summable (BYN + RUB is
// meaningless), so totals are grouped by ISO currency. The by-day series is built for ONE
// currency at a time (the chart shows a currency selector) — by default the DOMINANT one
// (most operations), so the first paint is the most representative.

import type { OperationDirection, StatementItem } from '~/types/statement'
import { round2 } from '~/utils/money'

/** Income (credit) + expense (debit) totals for one currency. Amounts are rounded to 2
 *  decimals (money display precision) AFTER summing, to avoid float drift accumulating. */
export interface CurrencyTotal {
  currency: string
  income: number
  expense: number
  incomeCount: number
  expenseCount: number
}

/** One day's income vs expense for a single currency (for the by-day bar/line chart). */
export interface DayBucket {
  /** ISO date `YYYY-MM-DD` (the operation's day). */
  date: string
  income: number
  expense: number
}

export interface ImportStats {
  /** Total operations counted. */
  total: number
  /** Per-currency income/expense totals, sorted by currency code (stable order). */
  byCurrency: CurrencyTotal[]
  /** Currency with the most operations (ties → lexicographically smallest code); `null`
   *  when there are no operations. The by-day series and donut default to this currency. */
  dominantCurrency: string | null
  /** Income-vs-expense by day for `dominantCurrency`, sorted by date ascending; `[]` when
   *  there are no operations. Use `dayBucketsForCurrency` for a different currency. */
  byDay: DayBucket[]
}

/** The `CurrencyTotal` for a currency (the dominant one when `currency` is omitted), or a
 *  zeroed total when there are no operations / the currency isn't present. Centralizes the
 *  find + empty-state guard so every counter/donut consumer (slice 2) doesn't re-implement
 *  it — and keeps the "no operations → dominantCurrency null" edge in one place. */
export function currencyTotal(stats: ImportStats, currency?: string): CurrencyTotal {
  const target = currency ?? stats.dominantCurrency
  const found = target !== null && target !== undefined
    ? stats.byCurrency.find(c => c.currency === target)
    : undefined
  return found ?? { currency: target ?? '', income: 0, expense: 0, incomeCount: 0, expenseCount: 0 }
}

/** The day an operation falls on: `operDate` if present, else `acceptDate`, truncated to
 *  the `YYYY-MM-DD` prefix. Empty when neither is a usable ISO date. */
export function operationDay(item: StatementItem): string {
  const raw = item.operDate || item.acceptDate || ''
  // ISO 8601 date/datetime → take the date part before any `T`/space.
  const day = raw.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''
}

/** A finite, non-negative amount (statement amounts are positive; direction carries sign).
 *  A negative/NaN amount is coerced to 0 so it can't distort a total. */
function safeAmount(amount: number): number {
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}

/** Build the by-day income/expense series for ONE currency, sorted by date ascending.
 *  Operations of other currencies (and those without a usable day) are ignored. */
export function dayBucketsForCurrency(items: StatementItem[], currency: string): DayBucket[] {
  const byDay = new Map<string, { income: number, expense: number }>()
  for (const item of items) {
    if (item.currency !== currency) continue
    const day = operationDay(item)
    if (!day) continue
    const bucket = byDay.get(day) ?? { income: 0, expense: 0 }
    const amount = safeAmount(item.amount)
    if (item.direction === 'credit') bucket.income += amount
    else bucket.expense += amount
    byDay.set(day, bucket)
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, v]) => ({ date, income: round2(v.income), expense: round2(v.expense) }))
}

/** Aggregate a StatementItem[] into the import-result stats (#62). Pure; safe on `[]`. */
export function computeImportStats(items: StatementItem[]): ImportStats {
  const totals = new Map<string, CurrencyTotal>()
  for (const item of items) {
    const currency = item.currency || ''
    const t = totals.get(currency) ?? { currency, income: 0, expense: 0, incomeCount: 0, expenseCount: 0 }
    const amount = safeAmount(item.amount)
    const dir: OperationDirection = item.direction
    if (dir === 'credit') {
      t.income += amount
      t.incomeCount += 1
    } else {
      t.expense += amount
      t.expenseCount += 1
    }
    totals.set(currency, t)
  }

  const byCurrency: CurrencyTotal[] = [...totals.values()]
    .map(t => ({ ...t, income: round2(t.income), expense: round2(t.expense) }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))

  // Dominant = currency with the most operations; ties broken by the lexicographically
  // smallest code. `byCurrency` is already sorted asc, so a strictly-greater test keeps the
  // first (smallest) code on a tie — no separate op-count map needed (count = income+expense).
  let dominantCurrency: string | null = null
  let bestCount = -1
  for (const t of byCurrency) {
    const count = t.incomeCount + t.expenseCount
    if (count > bestCount) {
      bestCount = count
      dominantCurrency = t.currency
    }
  }

  return {
    total: items.length,
    byCurrency,
    dominantCurrency,
    byDay: dominantCurrency !== null ? dayBucketsForCurrency(items, dominantCurrency) : []
  }
}
